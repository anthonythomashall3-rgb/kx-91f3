# LOCKqz — rules for every Claude session

1. Other sessions are working on this repo at the same time. Before ANY edit: `git pull --rebase`,
   read `SESSIONS.md`, add your claim there, commit + push the claim, then work. Remove your claim
   when you push the finished work. Never edit files another session has claimed.
2. Run `bash app/tests/run_all.sh` before every push; push small commits often.
3. $0 forever: free plans only. Never use `wrangler d1 execute --file` (it rewrites the whole DB);
   use `--command`. Keep D1 writes minimal (free limit 100,000 rows/day).
4. Commit as `Claude <noreply@anthropic.com>`.
