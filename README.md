# 📚 BookCrossing NoSQL: Analytics & Recommendation Dashboard

An end-to-end NoSQL data analytics and book discovery platform powered by **MongoDB** and viewable/inspectable in **MongoDB Compass**, built for the **Book-Crossing Dataset** (`books.csv`, `ratings.csv`, and `users.csv`).

Based on the research and academic project specification:  
**Course**: CSE494 - Intelligent NoSQL Databases  
**Author**: Ananya Jaiswal (Reg No: 12312358)  
**Supervisor**: Ms. Savleen Kaur, Lovely Professional University  

---

## 🏗️ Project Architecture

```
bookcrossing-nosql-dashboard/
├── backend/                        # Node.js + Express REST API & Aggregation Engine
│   ├── node_modules/
│   ├── package.json                # Express, MongoDB Native Driver, CORS, Dotenv
│   └── server.js                   # REST API endpoints & MongoDB aggregation pipelines
├── frontend/                       # Interactive Responsive Analytics Dashboard
│   └── index.html                  # Glassmorphic UI with Chart.js, Tailwind CSS & FontAwesome
├── scripts/
│   └── seed_mongo.py               # Fast, idempotent Python ETL with pandas & pymongo
├── .env.example                    # Environment configuration template
├── .env                            # Active environment variables
└── README.md                       # Comprehensive documentation & Compass guide
```

---

## 📊 Dataset Overview & Cleaning Rules

The dataset is located in: `C:\Users\anany\Downloads\archive (1)\books_data`

| Dataset | Parsed Records | Delimiter / Encoding | Primary Key / Indexes | Cleaning & Handling Rules |
| :--- | :--- | :--- | :--- | :--- |
| **`books.csv`** | ~270,491 | `;` (Semicolon) / `latin-1` | `ISBN` (Unique) | Malformed quoted rows skipped; numeric cast of `Year-Of-Publication` clamped to `[1450, 2026]`, outliers/future years set to `null`. |
| **`ratings.csv`** | ~1,149,766 | `;` (Semicolon) / `latin-1` | `User-ID`, `ISBN` (Compound) | `Book-Rating` bounded `0–10`. **0 indicates implicit interactions** (62.3% of data) and **1–10 are explicit ratings**. |
| **`users.csv`** | ~278,177 | `;` (Semicolon) / `latin-1` | `User-ID` (Unique) | `Age` has 39.7% missing values; invalid ages (`< 5` or `> 100`) converted to `null`. `Location` parsed into `city`, `state`, and `country`. |

---

## 🚀 Step-by-Step Setup & Quickstart

### Step 1: Verify MongoDB is Running
MongoDB Server is already configured and running as a Windows Service at `mongodb://localhost:27017`.

To verify via PowerShell or Command Prompt:
```powershell
mongosh "mongodb://localhost:27017" --eval "db.adminCommand('ping')"
```
*Expected Output:* `{ ok: 1 }`

---

### Step 2: Open and Inspect in MongoDB Compass
1. Launch **MongoDB Compass** on your computer.
2. In the "New Connection" screen, enter the connection URI:
   ```text
   mongodb://localhost:27017
   ```
3. Click **Connect**.
4. In the left database navigation pane, you will see the database `bookcrossing_nosql` containing the collections:
   - `books`
   - `ratings`
   - `users`

---

### Step 3: Run the ETL Seeder Script

The ETL script (`scripts/seed_mongo.py`) is idempotent, fast, creates all required indexes, and supports sampling:

```powershell
# Quick sample test (e.g. 50,000 records per collection):
python scripts/seed_mongo.py --sample 50000 --drop

# OR load the full dataset:
python scripts/seed_mongo.py --drop
```

#### What the ETL Seeder Does:
1. Reads CSVs using `pandas` with `encoding="latin-1"` and `sep=";"`.
2. Validates and converts `Year-Of-Publication` (clamped between 1450 and 2026).
3. Cleans `Age` (converts `NULL`, `NaN`, `<5` or `>100` to `null`).
4. Extracts clean `country` from `Location`.
5. Uses `insert_many(..., ordered=False)` in batches of 10,000–15,000 documents for maximum throughput.
6. Builds optimal single and compound indexes.

---

### Step 4: Start the Dashboard Backend & UI

From the `backend/` directory:
```powershell
cd backend
npm start
```
The server will start at: **`http://localhost:5000`**

Open your web browser and navigate to:
👉 **[http://localhost:5000](http://localhost:5000)**

---

## 🖥️ Dashboard Features

1. **Analytics Overview**:
   - **KPI Summary**: Total Books, Total Users, Total Ratings, Average Explicit Rating, and Implicit vs. Explicit interaction percentages.
   - **Figure 1**: Distribution of Book Ratings (0–10) with special visual contrast for implicit interactions (0) vs positive evaluations (1–10).
   - **Figure 2**: Most Frequently Rated Books (*Wild Animus*, *The Lovely Bones*, *The Da Vinci Code*, etc.) with rating count and mean positive rating.
   - **Figure 3**: Top Authors by Catalogue Entries (*Agatha Christie*, *William Shakespeare*, *Stephen King*, etc.).
   - **Figure 4**: Book Catalogue by Publication-Year Bands (`≤1900`, `1901–1950`, `1951–1980`, `1981–1990`, `1991–2000`, `2001–2010`, `2011–2026`).
   - **Figure 5**: User Age Availability (~39.7% missing demonstration) & Age Bracket Demographics (`<18`, `18–24`, `25–34`, `35–49`, `50–64`, `65+`).
   - **Top Reader Geographies**: Extracted country distribution.

2. **Books Explorer**:
   - Live search by Book Title, Author, or ISBN.
   - Filter by Author and Publisher.
   - Book cover thumbnail preview, metadata, and "Rate this Book" shortcut.
   - Client pagination.

3. **Ratings Explorer**:
   - Filter by User-ID, ISBN, Rating type (`All`, `Explicit 1–10`, `Implicit 0`), and Min Score.
   - Resolves Book Title & Author in real-time using MongoDB `$lookup` aggregation pipeline.
   - Direct 1-click copy of Compass MQL queries for any record.

4. **Live Rating Injector**:
   - Interactive form to insert or update ratings directly into `bookcrossing_nosql.ratings`.
   - Generates an immediate MongoDB Compass query snippet `{ "User-ID": <userId>, "ISBN": "<isbn>" }` so you can verify the new record in Compass instantly!

5. **Compass Query Studio**:
   - Pre-formatted, 1-click copyable queries and aggregation pipelines matching Appendix A of the project report.

---

## 🔍 Appendix A: MongoDB Compass Queries & Aggregation Pipelines

You can paste these directly into MongoDB Compass's **Filter** bar or **Aggregations** builder:

### A.1 Document Counts in Each Collection
```javascript
// Run in mongosh or Compass Shell:
db.books.countDocuments({})
db.ratings.countDocuments({})
db.users.countDocuments({})
```

### A.2 Distribution of Book Ratings (Compass Aggregation)
Select collection `ratings` -> Click **Aggregations** tab:
```json
[
  { "$group": { "_id": "$Book-Rating", "count": { "$sum": 1 } } },
  { "$sort": { "_id": 1 } }
]
```

### A.3 Average Explicit Rating by ISBN (Compass Aggregation)
Select collection `ratings` -> Click **Aggregations** tab:
```json
[
  { "$match": { "Book-Rating": { "$gt": 0, "$lte": 10 } } },
  {
    "$group": {
      "_id": "$ISBN",
      "averageRating": { "$avg": "$Book-Rating" },
      "positiveRatingCount": { "$sum": 1 }
    }
  },
  { "$sort": { "averageRating": -1, "positiveRatingCount": -1 } },
  { "$limit": 20 }
]
```

### A.4 Most Frequently Rated ISBNs (Compass Aggregation)
Select collection `ratings` -> Click **Aggregations** tab:
```json
[
  { "$group": { "_id": "$ISBN", "ratingCount": { "$sum": 1 } } },
  { "$sort": { "ratingCount": -1 } },
  { "$limit": 20 }
]
```

### A.5 Join Rating Summaries with Book Catalogue ($lookup)
Select collection `ratings` -> Click **Aggregations** tab:
```json
[
  { "$match": { "Book-Rating": { "$gt": 0, "$lte": 10 } } },
  {
    "$group": {
      "_id": "$ISBN",
      "averageRating": { "$avg": "$Book-Rating" },
      "ratingCount": { "$sum": 1 }
    }
  },
  {
    "$lookup": {
      "from": "books",
      "localField": "_id",
      "foreignField": "ISBN",
      "as": "bookDetails"
    }
  },
  { "$unwind": "$bookDetails" },
  {
    "$project": {
      "_id": 0,
      "ISBN": "$_id",
      "title": "$bookDetails.Book-Title",
      "author": "$bookDetails.Book-Author",
      "averageRating": { "$round": ["$averageRating", 2] },
      "ratingCount": 1
    }
  },
  { "$sort": { "ratingCount": -1 } },
  { "$limit": 20 }
]
```

### A.6 Find Users with Missing Age (Compass Filter)
Select collection `users` -> Paste into **Filter**:
```json
{ "$or": [{ "Age": null }, { "Age": { "$exists": false } }] }
```

### A.7 Find Suspicious Publication Years (Compass Filter)
Select collection `books` -> Paste into **Filter**:
```json
{
  "$expr": {
    "$or": [
      { "$lt": ["$Year-Of-Publication", 1450] },
      { "$gt": ["$Year-Of-Publication", 2026] }
    ]
  }
}
```

---

## 🛠️ Technology Stack
- **Database**: MongoDB (Local Instance at `mongodb://localhost:27017`)
- **Inspection & Query Tool**: MongoDB Compass
- **ETL / Seed Pipeline**: Python 3.14 + `pandas` + `pymongo`
- **Backend**: Node.js + Express.js + Native MongoDB Driver
- **Frontend**: Single-Page Application (HTML5, Tailwind CSS, Chart.js, FontAwesome)
- **Deployment & Hosting**: Localhost (`http://localhost:5000`)
