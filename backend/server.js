const express = require('express');
const cors = require('cors');
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'bookcrossing_nosql';

app.use(cors());
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '..', 'frontend')));

let dbClient = null;
let db = null;

// Connect to MongoDB
async function connectDB() {
  try {
    dbClient = new MongoClient(MONGO_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 5000
    });
    await dbClient.connect();
    db = dbClient.db(DB_NAME);
    console.log(`[✓] Connected to MongoDB: ${MONGO_URI}`);
    console.log(`[✓] Active Database: ${DB_NAME}`);
  } catch (err) {
    console.error(`[-] MongoDB Connection Error:`, err.message);
  }
}

// Middleware to ensure DB connection
app.use((req, res, next) => {
  if (!db) {
    return res.status(503).json({
      error: 'MongoDB not connected. Ensure MongoDB is running at ' + MONGO_URI,
      dbName: DB_NAME
    });
  }
  next();
});

// Cache for KPIs (15 second TTL to keep dashboard snappy)
let kpiCache = { data: null, timestamp: 0 };

// 1. Health & Database Status
app.get('/api/health', async (req, res) => {
  try {
    const admin = db.admin();
    const ping = await admin.ping();
    const collections = await db.listCollections().toArray();
    const collNames = collections.map(c => c.name);

    let counts = {};
    for (const name of collNames) {
      counts[name] = await db.collection(name).estimatedDocumentCount();
    }

    res.json({
      status: 'healthy',
      database: DB_NAME,
      uri: MONGO_URI,
      ping: ping.ok === 1 ? 'ok' : 'degraded',
      collections: collNames,
      counts
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. High-Level KPI Summary
app.get('/api/kpi', async (req, res) => {
  try {
    const now = Date.now();
    if (kpiCache.data && (now - kpiCache.timestamp < 15000)) {
      return res.json(kpiCache.data);
    }

    const [totalBooks, totalUsers, totalRatings] = await Promise.all([
      db.collection('books').estimatedDocumentCount(),
      db.collection('users').estimatedDocumentCount(),
      db.collection('ratings').estimatedDocumentCount()
    ]);

    // Rating split aggregation
    const ratingSplit = await db.collection('ratings').aggregate([
      {
        $group: {
          _id: { $cond: [{ $gt: ['$Book-Rating', 0] }, 'explicit', 'implicit'] },
          count: { $sum: 1 },
          avgRating: { $avg: '$Book-Rating' }
        }
      }
    ]).toArray();

    const implicitItem = ratingSplit.find(r => r._id === 'implicit') || { count: 0 };
    const explicitItem = ratingSplit.find(r => r._id === 'explicit') || { count: 0, avgRating: 0 };

    const implicitCount = implicitItem.count;
    const explicitCount = explicitItem.count;
    const avgExplicit = explicitItem.avgRating ? Number(explicitItem.avgRating.toFixed(2)) : 0;

    const data = {
      database: DB_NAME,
      totalBooks,
      totalUsers,
      totalRatings,
      implicitCount,
      explicitCount,
      implicitPct: totalRatings ? Number(((implicitCount / totalRatings) * 100).toFixed(1)) : 0,
      explicitPct: totalRatings ? Number(((explicitCount / totalRatings) * 100).toFixed(1)) : 0,
      avgExplicitRating: avgExplicit
    };

    kpiCache = { data, timestamp: now };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Rating Distribution (0 to 10) - Figure 1
app.get('/api/analytics/rating-distribution', async (req, res) => {
  try {
    const dist = await db.collection('ratings').aggregate([
      {
        $group: {
          _id: '$Book-Rating',
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).toArray();

    // Ensure all ratings 0-10 are represented
    const fullDist = Array.from({ length: 11 }, (_, i) => {
      const match = dist.find(d => d._id === i);
      return {
        rating: i,
        count: match ? match.count : 0,
        type: i === 0 ? 'Implicit (0)' : `Explicit (${i})`
      };
    });

    res.json(fullDist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Most Frequently Rated Books - Figure 2 & Section 7.3
app.get('/api/analytics/top-books', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const minRatings = parseInt(req.query.minRatings) || 3;

    const pipeline = [
      {
        $group: {
          _id: '$ISBN',
          totalRatings: { $sum: 1 },
          explicitRatings: {
            $sum: { $cond: [{ $gt: ['$Book-Rating', 0] }, 1, 0] }
          },
          sumExplicitScore: {
            $sum: { $cond: [{ $gt: ['$Book-Rating', 0] }, '$Book-Rating', 0] }
          }
        }
      },
      {
        $match: {
          totalRatings: { $gte: minRatings }
        }
      },
      {
        $lookup: {
          from: 'books',
          localField: '_id',
          foreignField: 'ISBN',
          as: 'bookInfo'
        }
      },
      {
        $unwind: {
          path: '$bookInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 0,
          isbn: '$_id',
          title: { $ifNull: ['$bookInfo.Book-Title', 'Unknown Title'] },
          author: { $ifNull: ['$bookInfo.Book-Author', 'Unknown Author'] },
          publisher: { $ifNull: ['$bookInfo.Publisher', 'Unknown Publisher'] },
          year: '$bookInfo.Year-Of-Publication',
          image: { $ifNull: ['$bookInfo.Image-URL-M', '$bookInfo.Image-URL-S'] },
          totalRatings: 1,
          explicitRatings: 1,
          meanPositiveRating: {
            $cond: [
              { $gt: ['$explicitRatings', 0] },
              { $round: [{ $divide: ['$sumExplicitScore', '$explicitRatings'] }, 2] },
              0
            ]
          }
        }
      },
      { $sort: { totalRatings: -1 } },
      { $limit: limit }
    ];

    const results = await db.collection('ratings').aggregate(pipeline, { allowDiskUse: true }).toArray();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Top Authors by Catalogue Entries & Rating Activity - Figure 3 & Section 7.4
app.get('/api/analytics/top-authors', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const pipeline = [
      {
        $match: {
          'Book-Author': { $nin: [null, '', 'Unknown Author', 'nan', 'Not Applicable'] }
        }
      },
      {
        $group: {
          _id: '$Book-Author',
          bookCount: { $sum: 1 }
        }
      },
      { $sort: { bookCount: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          author: '$_id',
          bookCount: 1
        }
      }
    ];

    const authors = await db.collection('books').aggregate(pipeline).toArray();
    res.json(authors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Top Publishers by Catalogue Entries
app.get('/api/analytics/top-publishers', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const pipeline = [
      {
        $match: {
          Publisher: { $nin: [null, '', 'Unknown Publisher', 'nan'] }
        }
      },
      {
        $group: {
          _id: '$Publisher',
          bookCount: { $sum: 1 }
        }
      },
      { $sort: { bookCount: -1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          publisher: '$_id',
          bookCount: 1
        }
      }
    ];

    const publishers = await db.collection('books').aggregate(pipeline).toArray();
    res.json(publishers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Publication Year Bands - Figure 4 & Section 7.5
app.get('/api/analytics/publication-years', async (req, res) => {
  try {
    const pipeline = [
      {
        $match: {
          'Year-Of-Publication': { $gte: 1450, $lte: 2026 }
        }
      },
      {
        $project: {
          yearBand: {
            $switch: {
              branches: [
                { case: { $lte: ['$Year-Of-Publication', 1900] }, then: '≤1900' },
                { case: { $and: [{ $gte: ['$Year-Of-Publication', 1901] }, { $lte: ['$Year-Of-Publication', 1950] }] }, then: '1901–1950' },
                { case: { $and: [{ $gte: ['$Year-Of-Publication', 1951] }, { $lte: ['$Year-Of-Publication', 1980] }] }, then: '1951–1980' },
                { case: { $and: [{ $gte: ['$Year-Of-Publication', 1981] }, { $lte: ['$Year-Of-Publication', 1990] }] }, then: '1981–1990' },
                { case: { $and: [{ $gte: ['$Year-Of-Publication', 1991] }, { $lte: ['$Year-Of-Publication', 2000] }] }, then: '1991–2000' },
                { case: { $and: [{ $gte: ['$Year-Of-Publication', 2001] }, { $lte: ['$Year-Of-Publication', 2010] }] }, then: '2001–2010' },
                { case: { $gte: ['$Year-Of-Publication', 2011] }, then: '2011–2026' }
              ],
              default: 'Other'
            }
          }
        }
      },
      {
        $group: {
          _id: '$yearBand',
          count: { $sum: 1 }
        }
      }
    ];

    const results = await db.collection('books').aggregate(pipeline).toArray();
    
    // Ordered bands as defined in the project report
    const orderedBands = ['≤1900', '1901–1950', '1951–1980', '1981–1990', '1991–2000', '2001–2010', '2011–2026'];
    const formatted = orderedBands.map(band => {
      const match = results.find(r => r._id === band);
      return {
        band,
        count: match ? match.count : 0
      };
    });

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. User Demographics (Age Availability & Country Split) - Figure 5 & Section 7.6
app.get('/api/analytics/user-demographics', async (req, res) => {
  try {
    const totalUsers = await db.collection('users').estimatedDocumentCount();
    const agePresent = await db.collection('users').countDocuments({ Age: { $ne: null } });
    const ageMissing = totalUsers - agePresent;

    // Age distribution brackets
    const agePipeline = [
      { $match: { Age: { $ne: null } } },
      {
        $project: {
          bracket: {
            $switch: {
              branches: [
                { case: { $lt: ['$Age', 18] }, then: '<18' },
                { case: { $and: [{ $gte: ['$Age', 18] }, { $lte: ['$Age', 24] }] }, then: '18–24' },
                { case: { $and: [{ $gte: ['$Age', 25] }, { $lte: ['$Age', 34] }] }, then: '25–34' },
                { case: { $and: [{ $gte: ['$Age', 35] }, { $lte: ['$Age', 49] }] }, then: '35–49' },
                { case: { $and: [{ $gte: ['$Age', 50] }, { $lte: ['$Age', 64] }] }, then: '50–64' },
                { case: { $gte: ['$Age', 65] }, then: '65+' }
              ],
              default: 'Other'
            }
          }
        }
      },
      {
        $group: {
          _id: '$bracket',
          count: { $sum: 1 }
        }
      }
    ];

    const ageResults = await db.collection('users').aggregate(agePipeline).toArray();
    const orderedBrackets = ['<18', '18–24', '25–34', '35–49', '50–64', '65+'];
    const ageBrackets = orderedBrackets.map(b => {
      const match = ageResults.find(r => r._id === b);
      return { bracket: b, count: match ? match.count : 0 };
    });

    // Top Countries
    const countryPipeline = [
      { $match: { country: { $nin: [null, '', 'unknown'] } } },
      { $group: { _id: '$country', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, country: { $toUpper: '$_id' }, count: 1 } }
    ];
    const topCountries = await db.collection('users').aggregate(countryPipeline).toArray();

    res.json({
      availability: [
        { label: 'Age Present', count: agePresent, pct: totalUsers ? Number(((agePresent / totalUsers) * 100).toFixed(1)) : 0 },
        { label: 'Age Missing', count: ageMissing, pct: totalUsers ? Number(((ageMissing / totalUsers) * 100).toFixed(1)) : 0 }
      ],
      ageBrackets,
      topCountries
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Searchable, Filterable & Paginated Books Explorer
app.get('/api/books', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 12), 100);
    const skip = (page - 1) * limit;

    const query = {};

    if (req.query.search) {
      const s = req.query.search.trim();
      query.$or = [
        { ISBN: { $regex: s, $options: 'i' } },
        { 'Book-Title': { $regex: s, $options: 'i' } },
        { 'Book-Author': { $regex: s, $options: 'i' } }
      ];
    }

    if (req.query.author) {
      query['Book-Author'] = { $regex: req.query.author.trim(), $options: 'i' };
    }

    if (req.query.publisher) {
      query.Publisher = { $regex: req.query.publisher.trim(), $options: 'i' };
    }

    if (req.query.yearMin || req.query.yearMax) {
      query['Year-Of-Publication'] = {};
      if (req.query.yearMin) query['Year-Of-Publication'].$gte = parseInt(req.query.yearMin);
      if (req.query.yearMax) query['Year-Of-Publication'].$lte = parseInt(req.query.yearMax);
    }

    const [books, total] = await Promise.all([
      db.collection('books').find(query).skip(skip).limit(limit).toArray(),
      db.collection('books').countDocuments(query)
    ]);

    // Format books
    const formatted = books.map(b => ({
      _id: b._id,
      isbn: b.ISBN || b.isbn,
      title: b['Book-Title'] || b.title,
      author: b['Book-Author'] || b.author,
      year: b['Year-Of-Publication'] || b.year,
      publisher: b.Publisher || b.publisher,
      image: b['Image-URL-M'] || b['Image-URL-L'] || b['Image-URL-S'] || (b.images && b.images.m) || ''
    }));

    res.json({
      books: formatted,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Searchable & Filterable Ratings Explorer (with Book details lookup)
app.get('/api/ratings', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 15), 100);
    const skip = (page - 1) * limit;

    const match = {};

    if (req.query.userId) {
      match['User-ID'] = parseInt(req.query.userId);
    }

    if (req.query.isbn) {
      match.ISBN = req.query.isbn.trim();
    }

    if (req.query.type === 'explicit') {
      match['Book-Rating'] = { $gt: 0 };
    } else if (req.query.type === 'implicit') {
      match['Book-Rating'] = 0;
    }

    if (req.query.minRating) {
      match['Book-Rating'] = { ...match['Book-Rating'], $gte: parseInt(req.query.minRating) };
    }

    if (req.query.maxRating) {
      match['Book-Rating'] = { ...match['Book-Rating'], $lte: parseInt(req.query.maxRating) };
    }

    const pipeline = [
      { $match: match },
      { $sort: { _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: 'books',
          localField: 'ISBN',
          foreignField: 'ISBN',
          as: 'bookInfo'
        }
      },
      {
        $unwind: {
          path: '$bookInfo',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          _id: 1,
          userId: '$User-ID',
          isbn: '$ISBN',
          rating: '$Book-Rating',
          isImplicit: { $eq: ['$Book-Rating', 0] },
          bookTitle: { $ifNull: ['$bookInfo.Book-Title', 'Title not in catalogue'] },
          bookAuthor: { $ifNull: ['$bookInfo.Book-Author', 'N/A'] },
          bookImage: '$bookInfo.Image-URL-S'
        }
      }
    ];

    const [ratings, total] = await Promise.all([
      db.collection('ratings').aggregate(pipeline).toArray(),
      db.collection('ratings').countDocuments(match)
    ]);

    res.json({
      ratings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Add or Update a Rating (Live verification in UI + Compass)
app.post('/api/ratings', async (req, res) => {
  try {
    const { userId, isbn, rating } = req.body;

    if (!userId || !isbn || rating === undefined) {
      return res.status(400).json({ error: 'userId, isbn, and rating (0-10) are required.' });
    }

    const uid = parseInt(userId);
    const cleanIsbn = String(isbn).trim();
    const score = parseInt(rating);

    if (isNaN(uid) || uid <= 0) {
      return res.status(400).json({ error: 'Invalid userId. Must be a positive integer.' });
    }

    if (isNaN(score) || score < 0 || score > 10) {
      return res.status(400).json({ error: 'Rating must be an integer between 0 and 10.' });
    }

    // Upsert rating in MongoDB
    const filter = { 'User-ID': uid, ISBN: cleanIsbn };
    const update = {
      $set: {
        'User-ID': uid,
        ISBN: cleanIsbn,
        'Book-Rating': score,
        userId: uid,
        isbn: cleanIsbn,
        rating: score,
        isImplicit: score === 0,
        updatedAt: new Date()
      }
    };

    const result = await db.collection('ratings').updateOne(filter, update, { upsert: true });

    // Fetch matching book metadata if available
    const book = await db.collection('books').findOne({ ISBN: cleanIsbn });

    // Invalidate KPI cache
    kpiCache.timestamp = 0;

    res.json({
      success: true,
      message: result.upsertedCount > 0 ? 'New rating created in MongoDB' : 'Existing rating updated in MongoDB',
      document: {
        userId: uid,
        isbn: cleanIsbn,
        rating: score,
        bookTitle: book ? book['Book-Title'] : 'Unknown Book'
      },
      compassInstructions: `Open Compass, select '${DB_NAME}.ratings', and query: { "User-ID": ${uid}, ISBN: "${cleanIsbn}" }`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. MongoDB Compass Query Helper & Appendix Queries
app.get('/api/compass/queries', (req, res) => {
  res.json({
    connection: {
      uri: MONGO_URI,
      database: DB_NAME,
      compassFilterExample: '{ "Book-Rating": { $gt: 7 } }',
      instructions: "Open MongoDB Compass -> Click 'New Connection' -> Paste the URI -> Open database 'bookcrossing_nosql'"
    },
    collections: [
      {
        name: 'books',
        description: 'Book catalogue items',
        keyIndexes: ['ISBN (unique)', 'Book-Author', 'Publisher', 'Year-Of-Publication'],
        sampleQueries: [
          {
            title: 'Find Books by Author (e.g. Stephen King)',
            type: 'filter',
            code: '{ "Book-Author": "Stephen King" }'
          },
          {
            title: 'Find Books Published Between 2000 and 2005',
            type: 'filter',
            code: '{ "Year-Of-Publication": { $gte: 2000, $lte: 2005 } }'
          },
          {
            title: 'Check Suspicious Publication Years (Appendix A.7)',
            type: 'filter',
            code: '{ $expr: { $or: [{ $lt: ["$Year-Of-Publication", 1450] }, { $gt: ["$Year-Of-Publication", 2026] }] } }'
          }
        ]
      },
      {
        name: 'ratings',
        description: 'User ratings linking User-ID and ISBN',
        keyIndexes: ['ISBN', 'User-ID', 'Book-Rating', 'User-ID + ISBN (unique)'],
        sampleQueries: [
          {
            title: 'Find Explicit High Ratings (8-10)',
            type: 'filter',
            code: '{ "Book-Rating": { $gte: 8, $lte: 10 } }'
          },
          {
            title: 'Find Implicit Ratings (0)',
            type: 'filter',
            code: '{ "Book-Rating": 0 }'
          },
          {
            title: 'Rating Distribution Pipeline (Appendix A.2)',
            type: 'aggregation',
            code: JSON.stringify([
              { $group: { _id: "$Book-Rating", count: { $sum: 1 } } },
              { $sort: { _id: 1 } }
            ], null, 2)
          },
          {
            title: 'Top 10 Most Frequently Rated ISBNs (Appendix A.4)',
            type: 'aggregation',
            code: JSON.stringify([
              { $group: { _id: "$ISBN", ratingCount: { $sum: 1 } } },
              { $sort: { ratingCount: -1 } },
              { $limit: 10 }
            ], null, 2)
          },
          {
            title: 'Join Rating Summaries with Books Catalogue ($lookup) (Appendix A.5)',
            type: 'aggregation',
            code: JSON.stringify([
              { $match: { "Book-Rating": { $gt: 0 } } },
              { $group: { _id: "$ISBN", averageRating: { $avg: "$Book-Rating" }, ratingCount: { $sum: 1 } } },
              { $lookup: { from: "books", localField: "_id", foreignField: "ISBN", as: "bookDetails" } },
              { $unwind: "$bookDetails" },
              { $project: { _id: 0, ISBN: "$_id", title: "$bookDetails.Book-Title", author: "$bookDetails.Book-Author", averageRating: { $round: ["$averageRating", 2] }, ratingCount: 1 } },
              { $sort: { ratingCount: -1 } },
              { $limit: 10 }
            ], null, 2)
          }
        ]
      },
      {
        name: 'users',
        description: 'User reader profiles and demographics',
        keyIndexes: ['User-ID (unique)', 'Age', 'country'],
        sampleQueries: [
          {
            title: 'Find Users with Missing Age (Appendix A.6)',
            type: 'filter',
            code: '{ $or: [{ Age: null }, { Age: { $exists: false } }] }'
          },
          {
            title: 'Find Users by Country (e.g. Canada)',
            type: 'filter',
            code: '{ country: "canada" }'
          }
        ]
      }
    ]
  });
});

// 13. Live Dynamic Query Runner for Dashboard Charts & Custom MQL
app.post('/api/query/run', async (req, res) => {
  const startTime = Date.now();
  try {
    const { collection, type = 'aggregate', pipeline, filter, sort, limit = 50 } = req.body;

    if (!collection || !['books', 'ratings', 'users'].includes(collection)) {
      return res.status(400).json({ error: 'Collection must be one of: books, ratings, users' });
    }

    const coll = db.collection(collection);
    let results = [];

    if (type === 'aggregate') {
      const aggPipeline = Array.isArray(pipeline) ? pipeline : [];
      results = await coll.aggregate(aggPipeline, { allowDiskUse: true }).toArray();
    } else {
      const q = filter || {};
      const s = sort || {};
      const l = Math.min(parseInt(limit) || 20, 100);
      results = await coll.find(q).sort(s).limit(l).toArray();
    }

    const executionTimeMs = Date.now() - startTime;
    res.json({
      success: true,
      collection,
      type,
      count: results.length,
      executionTimeMs,
      results
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      executionTimeMs: Date.now() - startTime
    });
  }
});

// Fallback to index.html for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Start Express server
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 BookCrossing Analytics Dashboard Backend Live!`);
    console.log(`   URL: http://localhost:${PORT}`);
    console.log(`   MongoDB: ${MONGO_URI}/${DB_NAME}`);
    console.log(`==================================================\n`);
  });
});
