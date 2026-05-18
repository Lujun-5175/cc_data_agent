"""Check the web.db for sessions."""
import sqlite3, os

db_path = os.path.expanduser("~/.cheetahclaws/web.db")
print(f"DB path: {db_path}")
print(f"DB exists: {os.path.exists(db_path)}")

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Check tables
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
print("Tables:", [r[0] for r in cur.fetchall()])

# Check users
cur.execute("SELECT id, username, is_admin FROM users")
print("Users:", cur.fetchall())

# Check sessions
cur.execute("SELECT COUNT(*) FROM chat_sessions")
print(f"Sessions count: {cur.fetchone()[0]}")

cur.execute("SELECT id, title, user_id, last_active FROM chat_sessions ORDER BY last_active DESC LIMIT 10")
for row in cur.fetchall():
    print(f"  Session: id={row[0]}, title={row[1]}, user_id={row[2]}, last_active={row[3]}")

# Check messages
cur.execute("SELECT COUNT(*) FROM messages")
print(f"Messages count: {cur.fetchone()[0]}")

# Check folders
cur.execute("SELECT COUNT(*) FROM folders")
print(f"Folders count: {cur.fetchone()[0]}")

conn.close()
