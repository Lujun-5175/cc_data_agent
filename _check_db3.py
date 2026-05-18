"""Check the web.db for sessions - handle encoding."""
import sqlite3, os, sys

db_path = os.path.expanduser("~/.cheetahclaws/web.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute("SELECT id, user_id, last_active FROM chat_sessions ORDER BY last_active DESC LIMIT 10")
for row in cur.fetchall():
    print(f"  Session: id={row[0]!r}, user_id={row[1]!r}, last_active={row[2]!r}")

cur.execute("SELECT id, username FROM users")
users = cur.fetchall()
print(f"Users ({len(users)}): {users}")

cur.execute("SELECT id, name FROM folders")
folders = cur.fetchall()
print(f"Folders: {folders}")

cur.execute("SELECT user_id, provider FROM api_credentials")
creds = cur.fetchall()
print(f"API credentials: {creds}")

conn.close()
