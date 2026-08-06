#!/bin/bash
# Initialize MCP organizational sandbox infrastructure
# Run this as root or with sudo privileges

set -e

echo "🔧 Setting up MCP organizational sandbox..."

# Create base sandbox directory
BASE_DIR="/var/mcp/isolated"
mkdir -p "$BASE_DIR"

# Set ownership and permissions
# Node.js process should own this (typically user 1000:1000 or node:node)
chown -R node:node "$BASE_DIR" 2>/dev/null || chown -R $(whoami):$(whoami) "$BASE_DIR"
chmod 700 "$BASE_DIR"

# Verify permissions
if [ "$(stat -c '%U:%G' "$BASE_DIR")" = "node:node" ]; then
    echo "✅ Base directory owned by node:node"
elif [ "$(stat -c '%U:%G' "$BASE_DIR")" = "$(whoami):$(whoami)" ]; then
    echo "✅ Base directory owned by $(whoami)"
else
    echo "⚠️  Warning: Directory ownership is $(stat -c '%U:%G' "$BASE_DIR"), expected node:node or your user"
fi

chmod 700 "$BASE_DIR"
echo "✅ Created $BASE_DIR with restricted access"

# Create systemd service for cleanup job (optional)
cat > /etc/systemd/system/mcp-sandbox-cleanup.service <<EOF
[Unit]
Description=MCP Sandbox Cleanup Service
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash -c 'find /var/mcp/isolated -type d -empty -delete'
User=node
Group=node
Environment=NODE_ENV=production
EOF

cat > /etc/systemd/system/mcp-sandbox-cleanup.timer <<EOF
[Unit]
Description=Clean up empty MCP sandbox directories daily
OnCalendar=daily
Persistent=true

[Timer]
Unit=mcp-sandbox-cleanup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable mcp-sandbox-cleanup.timer
systemctl start mcp-sandbox-cleanup.timer

echo "✅ Installed cleanup timer (runs daily)"
echo ""
echo "📝 Sandbox directories will be created automatically when organizations install MCP servers."
echo "🗑️  Empty sandbox directories are cleaned up daily via systemd timer."
echo ""
echo "Setup complete! MCP servers now run in isolated org-level environments."
