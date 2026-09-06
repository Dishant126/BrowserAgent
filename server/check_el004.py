import sqlite3
con = sqlite3.connect('privacy_agent.db')
cur = con.cursor()
row = cur.execute("SELECT prompt_sent FROM actions WHERE id=94").fetchone()
for line in row[0].splitlines():
    if "el_004" in line:
        print("el_004 line:", line)
