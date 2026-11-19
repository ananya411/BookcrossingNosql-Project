"""
Fast, Idempotent MongoDB ETL & Seeder for Book-Crossing Dataset
Database: bookcrossing_nosql
Author: Ananya Jaiswal / CSE494 Intelligent NoSQL Databases Project
"""

import os
import sys
import argparse
import time
import re
import pandas as pd
from pymongo import MongoClient, ASCENDING, TEXT
from pymongo.errors import BulkWriteError

DEFAULT_DATA_DIR = r"C:\Users\anany\Downloads\archive (1)\books_data"
DEFAULT_MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DEFAULT_DB_NAME = os.getenv("DB_NAME", "bookcrossing_nosql")

def clean_year(val):
    if pd.isna(val):
        return None
    try:
        val_str = str(val).strip()
        y = int(float(val_str))
        if 1450 <= y <= 2026:
            return y
        return None
    except Exception:
        return None

def clean_age(val):
    if pd.isna(val):
        return None
    try:
        val_str = str(val).strip()
        if val_str.upper() in ("NULL", "NAN", ""):
            return None
        a = int(float(val_str))
        if 5 <= a <= 100:
            return a
        return None
    except Exception:
        return None

def parse_location(loc_str):
    if not loc_str or pd.isna(loc_str):
        return {"city": None, "state": None, "country": None}
    parts = [p.strip().lower() for p in str(loc_str).split(",")]
    city = parts[0] if len(parts) > 0 and parts[0] else None
    state = parts[1] if len(parts) > 1 and parts[1] else None
    country = parts[-1] if len(parts) > 2 and parts[-1] else (parts[1] if len(parts) > 1 else None)
    # clean dirty characters
    if country:
        country = re.sub(r'[^a-zA-Z\s]', '', country).strip()
        if country in ('', 'unknown', 'n/a', 'na'):
            country = None
    return {"city": city, "state": state, "country": country}

def seed_books(db, data_dir, sample_size=None, batch_size=10000):
    books_file = os.path.join(data_dir, "books.csv")
    if not os.path.exists(books_file):
        print(f"[-] Error: File not found: {books_file}")
        return 0

    print(f"\n[+] Processing books from: {books_file}")
    start_time = time.time()
    
    # Read CSV with pandas, skipping bad quoted rows
    df = pd.read_csv(
        books_file,
        sep=";",
        encoding="latin-1",
        dtype=str,
        on_bad_lines="skip",
        nrows=sample_size
    )
    
    total_rows = len(df)
    print(f"    Loaded {total_rows:,} raw book records into memory...")

    docs = []
    seen_isbns = set()
    total_inserted = 0

    for idx, row in df.iterrows():
        raw_isbn = str(row.get("ISBN", "")).strip().strip('"').strip("'")
        if not raw_isbn or raw_isbn in seen_isbns:
            continue
        seen_isbns.add(raw_isbn)

        title = str(row.get("Book-Title", "")).strip() if pd.notna(row.get("Book-Title")) else "Unknown Title"
        author = str(row.get("Book-Author", "")).strip() if pd.notna(row.get("Book-Author")) else None
        publisher = str(row.get("Publisher", "")).strip() if pd.notna(row.get("Publisher")) else None
        year = clean_year(row.get("Year-Of-Publication"))
        
        img_s = str(row.get("Image-URL-S", "")).strip() if pd.notna(row.get("Image-URL-S")) else ""
        img_m = str(row.get("Image-URL-M", "")).strip() if pd.notna(row.get("Image-URL-M")) else ""
        img_l = str(row.get("Image-URL-L", "")).strip() if pd.notna(row.get("Image-URL-L")) else ""

        doc = {
            # Standard source keys (for project report compatibility & Compass queries)
            "ISBN": raw_isbn,
            "Book-Title": title,
            "Book-Author": author,
            "Year-Of-Publication": year,
            "Publisher": publisher,
            "Image-URL-S": img_s,
            "Image-URL-M": img_m,
            "Image-URL-L": img_l,
            # Clean normalized keys for modern REST API & UI
            "isbn": raw_isbn,
            "title": title,
            "author": author or "Unknown Author",
            "year": year,
            "publisher": publisher or "Unknown Publisher",
            "images": {
                "s": img_s,
                "m": img_m,
                "l": img_l
            }
        }
        docs.append(doc)

        if len(docs) >= batch_size:
            try:
                db.books.insert_many(docs, ordered=False)
            except BulkWriteError as bwe:
                pass
            total_inserted += len(docs)
            print(f"    Inserted {total_inserted:,} / {total_rows:,} books...", end="\r")
            docs = []

    if docs:
        try:
            db.books.insert_many(docs, ordered=False)
        except BulkWriteError:
            pass
        total_inserted += len(docs)

    elapsed = time.time() - start_time
    print(f"\n[✓] Books completed: {total_inserted:,} documents inserted in {elapsed:.2f}s")
    return total_inserted

def seed_users(db, data_dir, sample_size=None, batch_size=10000):
    users_file = os.path.join(data_dir, "users.csv")
    if not os.path.exists(users_file):
        print(f"[-] Error: File not found: {users_file}")
        return 0

    print(f"\n[+] Processing users from: {users_file}")
    start_time = time.time()

    df = pd.read_csv(
        users_file,
        sep=";",
        encoding="latin-1",
        dtype=str,
        on_bad_lines="skip",
        nrows=sample_size
    )

    total_rows = len(df)
    print(f"    Loaded {total_rows:,} raw user records into memory...")

    docs = []
    seen_ids = set()
    total_inserted = 0

    for idx, row in df.iterrows():
        raw_id = str(row.get("User-ID", "")).strip()
        try:
            user_id = int(raw_id)
        except Exception:
            continue
        if user_id in seen_ids:
            continue
        seen_ids.add(user_id)

        raw_loc = str(row.get("Location", "")).strip() if pd.notna(row.get("Location")) else ""
        age = clean_age(row.get("Age"))
        loc_parts = parse_location(raw_loc)

        doc = {
            # Source keys
            "User-ID": user_id,
            "Location": raw_loc,
            "Age": age,
            # Clean normalized keys
            "userId": user_id,
            "location": raw_loc,
            "age": age,
            "city": loc_parts["city"],
            "state": loc_parts["state"],
            "country": loc_parts["country"]
        }
        docs.append(doc)

        if len(docs) >= batch_size:
            try:
                db.users.insert_many(docs, ordered=False)
            except BulkWriteError:
                pass
            total_inserted += len(docs)
            print(f"    Inserted {total_inserted:,} / {total_rows:,} users...", end="\r")
            docs = []

    if docs:
        try:
            db.users.insert_many(docs, ordered=False)
        except BulkWriteError:
            pass
        total_inserted += len(docs)

    elapsed = time.time() - start_time
    print(f"\n[✓] Users completed: {total_inserted:,} documents inserted in {elapsed:.2f}s")
    return total_inserted

def seed_ratings(db, data_dir, sample_size=None, batch_size=15000):
    ratings_file = os.path.join(data_dir, "ratings.csv")
    if not os.path.exists(ratings_file):
        print(f"[-] Error: File not found: {ratings_file}")
        return 0

    print(f"\n[+] Processing ratings from: {ratings_file}")
    start_time = time.time()

    df = pd.read_csv(
        ratings_file,
        sep=";",
        encoding="latin-1",
        dtype=str,
        on_bad_lines="skip",
        nrows=sample_size
    )

    total_rows = len(df)
    print(f"    Loaded {total_rows:,} raw rating records into memory...")

    docs = []
    seen_pairs = set()
    total_inserted = 0

    for idx, row in df.iterrows():
        raw_uid = str(row.get("User-ID", "")).strip()
        raw_isbn = str(row.get("ISBN", "")).strip().strip('"').strip("'")
        raw_rating = str(row.get("Book-Rating", "")).strip()

        try:
            user_id = int(raw_uid)
            rating = int(raw_rating)
        except Exception:
            continue

        if not raw_isbn:
            continue
        
        # Guard against duplicate (User-ID, ISBN) pairs
        pair_key = (user_id, raw_isbn)
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)

        # Restrict rating to 0-10
        rating = max(0, min(10, rating))

        doc = {
            # Source keys
            "User-ID": user_id,
            "ISBN": raw_isbn,
            "Book-Rating": rating,
            # Clean normalized keys
            "userId": user_id,
            "isbn": raw_isbn,
            "rating": rating,
            "isImplicit": (rating == 0)
        }
        docs.append(doc)

        if len(docs) >= batch_size:
            try:
                db.ratings.insert_many(docs, ordered=False)
            except BulkWriteError:
                pass
            total_inserted += len(docs)
            print(f"    Inserted {total_inserted:,} / {total_rows:,} ratings...", end="\r")
            docs = []

    if docs:
        try:
            db.ratings.insert_many(docs, ordered=False)
        except BulkWriteError:
            pass
        total_inserted += len(docs)

    elapsed = time.time() - start_time
    print(f"\n[✓] Ratings completed: {total_inserted:,} documents inserted in {elapsed:.2f}s")
    return total_inserted

def create_indexes(db):
    print("\n[+] Creating indexes on collections for optimal query & Compass explain plans...")
    start_time = time.time()

    # Books collection indexes
    print("    -> Indexing 'books' collection...")
    db.books.create_index([("ISBN", ASCENDING)], unique=True, name="idx_isbn_unique")
    db.books.create_index([("Book-Author", ASCENDING)], name="idx_author")
    db.books.create_index([("Publisher", ASCENDING)], name="idx_publisher")
    db.books.create_index([("Year-Of-Publication", ASCENDING)], name="idx_year")
    db.books.create_index([("author", ASCENDING)], name="idx_author_norm")
    db.books.create_index([("title", ASCENDING)], name="idx_title_norm")

    # Users collection indexes
    print("    -> Indexing 'users' collection...")
    db.users.create_index([("User-ID", ASCENDING)], unique=True, name="idx_userid_unique")
    db.users.create_index([("Age", ASCENDING)], name="idx_age")
    db.users.create_index([("country", ASCENDING)], name="idx_country")

    # Ratings collection indexes
    print("    -> Indexing 'ratings' collection...")
    db.ratings.create_index([("ISBN", ASCENDING)], name="idx_ratings_isbn")
    db.ratings.create_index([("User-ID", ASCENDING)], name="idx_ratings_userid")
    db.ratings.create_index([("Book-Rating", ASCENDING)], name="idx_ratings_rating")
    db.ratings.create_index([("User-ID", ASCENDING), ("ISBN", ASCENDING)], unique=True, name="idx_user_isbn_unique")

    elapsed = time.time() - start_time
    print(f"[✓] Indexes created successfully in {elapsed:.2f}s!")

def print_summary_kpis(db):
    print("\n==================================================")
    print("   ETL SUMMARY & MONGODB COMPASS VERIFICATION     ")
    print("==================================================")
    total_books = db.books.count_documents({})
    total_users = db.users.count_documents({})
    total_ratings = db.ratings.count_documents({})
    
    # Aggregation for rating split
    pipeline = [
        {
            "$group": {
                "_id": {"$cond": [{"$gt": ["$Book-Rating", 0]}, "explicit", "implicit"]},
                "count": {"$sum": 1},
                "avgRating": {"$avg": "$Book-Rating"}
            }
        }
    ]
    res = list(db.ratings.aggregate(pipeline))
    implicit_count = next((r["count"] for r in res if r["_id"] == "implicit"), 0)
    explicit_count = next((r["count"] for r in res if r["_id"] == "explicit"), 0)
    avg_explicit = next((r["avgRating"] for r in res if r["_id"] == "explicit"), 0.0)

    print(f"Database Name:            {db.name}")
    print(f"Total Books:              {total_books:,}")
    print(f"Total Users:              {total_users:,}")
    print(f"Total Ratings:            {total_ratings:,}")
    print(f"Explicit Ratings (1-10):  {explicit_count:,} ({explicit_count/max(1, total_ratings)*100:.1f}%)")
    print(f"Implicit Ratings (0):     {implicit_count:,} ({implicit_count/max(1, total_ratings)*100:.1f}%)")
    print(f"Average Explicit Rating:  {avg_explicit:.2f} / 10")
    print("==================================================\n")

def main():
    parser = argparse.ArgumentParser(description="Seed MongoDB with Book-Crossing dataset.")
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Path to folder containing books.csv, ratings.csv, users.csv")
    parser.add_argument("--mongo-uri", default=DEFAULT_MONGO_URI, help="MongoDB connection URI")
    parser.add_argument("--db-name", default=DEFAULT_DB_NAME, help="MongoDB database name")
    parser.add_argument("--sample", type=int, default=None, help="Sample size limit for fast testing (e.g. 50000)")
    parser.add_argument("--drop", action="store_true", help="Drop existing collections before seeding")
    args = parser.parse_args()

    print("==================================================")
    print("  BOOK-CROSSING NoSQL ETL SEEDER (MONGODB)        ")
    print("==================================================")
    print(f"Data Directory:  {args.data_dir}")
    print(f"MongoDB URI:     {args.mongo_uri}")
    print(f"Target Database: {args.db_name}")
    print(f"Sample Limit:    {args.sample or 'Full Dataset'}")
    print(f"Drop First:      {args.drop}")
    print("==================================================")

    client = MongoClient(args.mongo_uri)
    db = client[args.db_name]

    if args.drop:
        print("[!] Dropping existing collections in target database...")
        db.books.drop()
        db.users.drop()
        db.ratings.drop()

    seed_books(db, args.data_dir, sample_size=args.sample)
    seed_users(db, args.data_dir, sample_size=args.sample)
    seed_ratings(db, args.data_dir, sample_size=args.sample)

    create_indexes(db)
    print_summary_kpis(db)
    print("Ready to inspect in MongoDB Compass at: mongodb://localhost:27017 -> db: bookcrossing_nosql")

if __name__ == "__main__":
    main()
