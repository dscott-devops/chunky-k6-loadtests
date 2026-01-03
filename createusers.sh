#!/bin/bash
#
cat > users.json <<'EOF'
[
EOF

for i in $(seq -w 1 99); do
  comma=","
  [ "$i" = "99" ] && comma=""
  printf '  { "email": "testuser00%s@chunky.test", "password": "Test1234!" }%s\n' "$i" "$comma" >> users.json
done

cat >> users.json <<'EOF'
]
EOF

