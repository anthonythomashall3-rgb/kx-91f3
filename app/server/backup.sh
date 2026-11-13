#!/bin/bash
# Nightly copy of the server's databases, off the machine. Each night: a consistent snapshot of every database,
# packed and encrypted to a public key (the private key is not on this machine), then pushed to a private
# repository. Seven files rotate by weekday; the repository keeps no history, so it never grows.
#   install: sudo bash backup.sh install      run once now: sudo systemctl start lockqz-backup
#   needs /etc/lockqz-backup/{backup-pub.pem, deploy_key, remote}   (remote = git@github.com:owner/repo.git)
# Read a copy back (where the private key is):
#   tar xf backup-Mon.bin && openssl pkeyutl -decrypt -inkey backup-key.pem -pkeyopt rsa_padding_mode:oaep -in key.enc -out k \
#     && openssl enc -d -aes-256-cbc -pbkdf2 -in data.enc -out db.tgz -pass file:k && tar xzf db.tgz
set -euo pipefail
C=/etc/lockqz-backup; D=${LOCKQZ_DATA:-/opt/lockqz/app/server/data}; R=/var/lib/lockqz-backup
if [ "${1:-}" = install ]; then
  install -m 755 "$0" /usr/local/sbin/lockqz-backup
  printf '[Unit]\nDescription=LOCKqz nightly database copy\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/lockqz-backup\n' > /etc/systemd/system/lockqz-backup.service
  printf '[Unit]\nDescription=LOCKqz nightly database copy\n[Timer]\nOnCalendar=*-*-* 10:20:00 UTC\nRandomizedDelaySec=600\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/lockqz-backup.timer
  systemctl daemon-reload; systemctl enable --now lockqz-backup.timer; exit 0
fi
NODE=$(command -v node || echo /usr/local/bin/node); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; umask 077
mkdir -p "$W/db/schools" "$R"
n=0
for f in "$D"/lockqz.db "$D"/directory.db "$D"/schools/*.db; do
  [ -f "$f" ] || continue
  "$NODE" --no-warnings -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});d.prepare("VACUUM INTO ?").run(process.argv[2]);d.close()' "$f" "$W/db/${f#"$D"/}"
  n=$((n+1))
done
[ "$n" -gt 0 ] || { echo "no database to copy in $D"; exit 1; }
[ -f "$D/schools.json" ] && cp "$D/schools.json" "$W/db/"
date -u +%FT%TZ > "$W/db/taken"
tar -C "$W" -czf "$W/db.tgz" db
openssl rand -hex 32 > "$W/k"
mkdir "$W/out"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$W/db.tgz" -out "$W/out/data.enc" -pass "file:$W/k"
openssl pkeyutl -encrypt -pubin -inkey "$C/backup-pub.pem" -pkeyopt rsa_padding_mode:oaep -in "$W/k" -out "$W/out/key.enc"
day=$(date -u +%a)
tar -C "$W/out" -cf "$R/backup-$day.bin" data.enc key.enc
cd "$R"; rm -rf .git; git init -q -b main; git add -A
git -c user.name=lockqz-server -c user.email=noreply@lockqz.com commit -q -m "copies up to $(date -u +%F)"
GIT_SSH_COMMAND="ssh -i $C/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$C/known_hosts" git push -q -f "$(cat "$C/remote")" main
echo "copied $n database(s), $(stat -c %s "$R/backup-$day.bin") bytes, backup-$day.bin"
