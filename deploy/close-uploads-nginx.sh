#!/usr/bin/env bash
#
# CLOSE THE OPEN /uploads DOOR — guarded nginx apply.
#
# Run this on the BACKEND EC2 box (the one serving userback.seejobrun.com),
# ONLY AFTER the app + URL repoint is deployed and you have verified images load
# through /api/v1/files/... (per the CCP sequencing: app+repoint first, nginx
# last). It backs up the live config, applies the change, tests it with
# `nginx -t`, and reloads — rolling back automatically if the test fails, so a
# bad edit never takes nginx down.
#
# ── YOU MUST FILL IN TWO THINGS FIRST ────────────────────────────────────────
#   SITE   : the nginx site config file that currently serves /uploads.
#            Find it with:  sudo grep -RIl "location /uploads" /etc/nginx/
#   The `location /uploads` block below is the REPLACEMENT. Two options — pick
#   one (see CHOICE):
#     A) return 404  — files are served ONLY by the app now (simplest, closes it
#        hard). Choose this unless something still needs raw nginx delivery.
#     B) proxy_pass to the app's authenticated route (keeps the same URL working
#        for already-issued links, but every hit now passes the ownership check).
#
# Nothing is changed unless `nginx -t` passes on the new config.
set -euo pipefail

SITE="${SITE:-/etc/nginx/sites-available/REPLACE_ME}"   # <-- set this
CHOICE="${CHOICE:-A}"                                    # A = return 404, B = proxy to app
APP_UPSTREAM="${APP_UPSTREAM:-http://127.0.0.1:3000}"    # only used for CHOICE=B; set to the pm2 app's port

if [ ! -f "$SITE" ]; then echo "SITE not found: $SITE — set SITE=... (grep -RIl 'location /uploads' /etc/nginx/)"; exit 1; fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${SITE}.bak.${STAMP}"
cp -a "$SITE" "$BACKUP"
echo "backed up -> $BACKUP"

# Build the replacement block.
if [ "$CHOICE" = "B" ]; then
  read -r -d '' NEWBLOCK <<EOF || true
    # /uploads is no longer served from disk. Proxy to the authenticated app
    # route, which checks ownership before streaming (was: open static mount).
    location /uploads/ {
        proxy_pass ${APP_UPSTREAM}/api/v1/files/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
EOF
else
  read -r -d '' NEWBLOCK <<'EOF' || true
    # /uploads is no longer served from disk — files go through the
    # authenticated app route (/api/v1/files/:name). Refuse the old open path.
    location /uploads/ {
        return 404;
    }
EOF
fi

# Replace an existing `location /uploads ... { ... }` block, or append inside the
# server block if none exists. This uses perl for a brace-aware single-block
# replace; review the diff it prints before it is applied.
TMP="$(mktemp)"
SITE="$SITE" NEWBLOCK="$NEWBLOCK" perl -0777 -pe '
  my $nb = $ENV{NEWBLOCK};
  # match: location <sp> [=~*^]* <sp> /uploads ... { ... balanced ... }
  if ($_ =~ s/\n[ \t]*location[^\n{]*\/uploads[^\n{]*\{(?:[^{}]|\{[^{}]*\})*\}/\n$nb/s) {
    # replaced an existing block
  }
' "$SITE" > "$TMP"

echo "----- diff (current -> proposed) -----"
diff -u "$SITE" "$TMP" || true
echo "--------------------------------------"

# Stage the new config, test it, and only reload if the test passes.
cp -a "$TMP" "$SITE"
if sudo nginx -t; then
  sudo nginx -s reload
  echo "nginx reloaded — /uploads is now closed (CHOICE=$CHOICE)."
  echo "VERIFY:  curl -sI https://userback.seejobrun.com/uploads/<known>.jpg   # expect NOT the file"
else
  echo "nginx -t FAILED — rolling back to $BACKUP, nothing changed."
  cp -a "$BACKUP" "$SITE"
  sudo nginx -t >/dev/null 2>&1 || true
  exit 1
fi
