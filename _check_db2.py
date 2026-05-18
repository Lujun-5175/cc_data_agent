"""Check the web.db for sessions - handle encoding."""
import sqlite3, os, sys

db_path = os.path.expanduser("~/.cheetahclaws/web.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute("SELECT id, title, user_id, last_active FROM chat_sessions ORDER BY last_active DESC LIMIT 10")
for row in cur.fetchall():
    title_repr = repr(row[1])
    print(f"  Session: id={row[0]!r}, title={title_repr}, user_id={row[2]!r}, last_active={row[3]!r}")

cur.execute("SELECT id, username FROM users")
print(f"Users: {cur.fetchall()}")

# Check api_credentials
cur.execute("SELECT user_id, provider FROM api_credentials")
print(f"API credentials: {cur.fetchall()}")

conn.close()
