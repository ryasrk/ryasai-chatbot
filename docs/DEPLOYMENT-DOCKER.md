# Docker Deployment Guide - MCP Org-Level Isolation

Your application runs in containers, but we're adding **host-level filesystem isolation** for MCP servers. This provides better multi-tenant security without needing additional Docker containers per server.

## Architecture Overview

```
Host System (your Docker host)
├── /var/mcp/isolated/          ← Shared across all containers
│   ├── org-{uuid-1}/           ← Organization 1's sandbox
│   │   ├── npx-cache/
│   │   └── .mcp-wrapper.sh
│   └── org-{uuid-2}/           ← Organization 2's sandbox
│       ├── npx-cache/
│       └── .mcp-wrapper.sh
│
└── Docker Containers
    └── ryasai-chatbot
        └── Mounts /var/mcp/isolated as read-write volume
```

Each organization gets its own sandbox directory on the **host**, and all app containers access it via mounted volumes.

## Pre-deployment Checklist

### 1. Docker Host Setup

On your Docker host (not inside the container):

```bash
# Ensure Docker is installed
docker --version

# Check if node.js is available on host
node --version  # v18+ recommended

# Create base sandbox directory
sudo mkdir -p /var/mcp/isolated
sudo chown $(whoami):$(whoami) /var/mcp/isolated  # Or use root
sudo chmod 700 /var/mcp/isolated
```

### 2. Update Application Container Configuration

#### Option A: If using docker-compose.yml

```yaml
version: '3.8'

services:
  ryasai-chatbot:
    build: .
    image: ryasai/chatbot:latest
    
    volumes:
      # Add sandbox volume mount
      - mcp-sandbox:/var/mcp/isolated
      
    # Environment variables
    environment:
      - DATABASE_URL=postgresql://...
      - MCP_SANDBOX_DIR=/var/mcp/isolated
      
    restart: unless-stopped
    
volumes:
  mcp-sandbox:
    driver: local
```

#### Option B: If using single docker run command

```bash
docker run -d \
  --name ryasai-chatbot \
  --restart unless-stopped \
  -e DATABASE_URL="postgresql://..." \
  -e MCP_SANDBOX_DIR="/var/mcp/isolated" \
  -v mcp-sandbox:/var/mcp/isolated \
  -p 3000:3000 \
  ryasai/chatbot:latest
```

### 3. Migrate Existing Servers

Run the migration script **inside** your running container:

```bash
# Enter the container
docker exec -it ryasai-chatbot sh

# Navigate to app directory
cd /app

# Run migration
bun run scripts/migrate-existing-orgs.ts

# Exit container
exit
```

Expected output:
```
📊 Scanning for organizations with MCP servers...
Found 5 organizations with 23 total servers

Creating sandbox for org: org-abc12345... ✅ (700)
Creating sandbox for org: org-def67890... ✅ (700)
...

✅ Migration complete! All organization sandboxes created
```

### 4. Verify Deployment

```bash
# Check sandbox directories exist on host
docker exec ryasai-chatbot ls -la /var/mcp/isolated/

# Should show:
# total 24
# drwx------ org-org-abc12345
# drwx------ org-org-def67890
# ...

# List MCP servers from within container
docker exec ryasai-chatbot curl http://localhost:3000/api/mcp/servers | jq

# Test MCP connection
docker exec -d ryasai-chatbot curl -X POST http://localhost:3000/api/mcp/test \
  -H "Content-Type: application/json" \
  -d '{"server": "your-server-name"}'
```

## Updating Your Current Setup

If you're already running Docker containers, here are three approaches:

### Approach 1: Modify docker-compose.yml (Recommended)

1. **Backup current config:**
```bash
cp docker-compose.yml docker-compose.yml.backup.$(date +%Y%m%d)
```

2. **Add volume mounts:**
```yaml
# Find your service definition
services:
  ryasai-chatbot:
    volumes:
      # Add these lines below existing volumes:
      - mcp-sandbox:/var/mcp/isolated
      # End of volumes section

# At bottom of file, add volume declaration:
volumes:
  mcp-sandbox:
    driver: local
```

3. **Restart services:**
```bash
docker compose down
docker compose pull  # Get updated code
docker compose build
docker compose up -d

# Run migration
docker compose exec ryasai-chatbot bun run scripts/migrate-existing-orgs.ts
```

### Approach 2: Modify Existing docker run Command

Find your current container and modify:

```bash
# Stop container
docker stop ryasai-chatbot
docker rm ryasai-chatbot

# Start with new volume configuration
docker run -d \
  --name ryasai-chatbot \
  --restart unless-stopped \
  -v mcp-sandbox:/var/mcp/isolated \
  # ... rest of your existing flags ...
  ryasai/chatbot:latest
```

Then run migration inside the container.

### Approach 3: Inject Volume into Running Container (Complex)

If you can't recreate the container, bind mount after startup:

```bash
# Create sandbox dir on host
sudo mkdir -p /var/mcp/isolated
sudo chmod 700 /var/mcp/isolated

# Create internal path in container
docker exec ryasai-chatbot mkdir -p /var/mcp/isolated

# Bind mount (requires privileged mode or special setup)
docker exec ryasai-chatbot mount --bind /var/mcp/isolated /var/mcp/isolated
```

⚠️ This approach requires advanced Docker knowledge. Prefer Approaches 1 or 2.

## Security Considerations for Docker

### Filesystem Permissions

Since containers share the host's `/var/mcp/isolated`, ensure proper permissions:

```bash
# On Docker host
ls -la /var/mcp/isolated/

# Each org directory should be:
drwx------ org-org-{uuid}
```

### Container User Isolation

Update your Dockerfile to ensure containers run with consistent UIDs:

```dockerfile
# In your Dockerfile
ARG NODE_UID=1000
ARG NODE_GID=1000

RUN groupadd --gid ${NODE_GID} nodejs && \
    useradd --uid ${NODE_UID} --gid ${NODE_GID} --shell /bin/bash --create-home nodejs

USER nodejs

ENV HOME=/home/nodejs
```

Or if using existing Dockerfile, verify the user:

```dockerfile
# Check who owns files
docker inspect ryasai-chatbot | grep -i uid
# Should be around 1000 (non-root)
```

### Resource Limits

Add resource constraints to your Docker run/compose config:

```yaml
# docker-compose.yml
services:
  ryasai-chatbot:
    mem_limit: 2g              # Memory limit
    cpus: 2.0                  # CPU cores
    pids_limit: 100            # Max processes
    
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2.0'
```

### Network Isolation (Optional Enhancement)

If you want to restrict outbound connections from MCP servers:

```yaml
# Use custom network with limited egress
networks:
  isolated-net:
    driver: bridge
    enable_ipv6: false
  
services:
  ryasai-chatbot:
    networks:
      - isolated-net
    # Configure firewall rules at host level
```

## Troubleshooting Common Issues

### Issue 1: Permission Denied When Creating Sandbox

**Symptom**: Logs show `EACCES: permission denied` for `/var/mcp/isolated`

**Fix**:
```bash
# Check ownership on host
sudo ls -la /var/mcp/

# Match container user UID
docker inspect ryasai-chatbot | grep '"Uid"'

# Set correct owner (example UID 1000)
sudo chown -R 1000:1000 /var/mcp/isolated
sudo chmod -R 700 /var/mcp/isolated
```

### Issue 2: No Sandboxes Created After Migration

**Symptom**: `bun run scripts/migrate-existing-orgs.ts` fails silently

**Debug**:
```bash
# Enter container
docker exec -it ryasai-chatbot sh

# Check database connectivity
echo 'SELECT organization_id FROM "McpServer";' | psql <db-url>

# Manually test sandbox creation
cd /app
bun src/scripts/migrate-existing-orgs.ts

# Check logs
tail -f /tmp/container.log | grep mcp
```

**Common Fix**: Database URL not accessible from container
```bash
docker exec ryasai-chatbot env | grep DATABASE_URL
```

### Issue 3: MCP Servers Not Connecting

**Symptom**: Connection errors when testing MCP servers

**Check**:
```bash
# Verify wrapper script exists
docker exec ryasai-chatbot ls -la /var/mcp/isolated/org-*/.mcp-wrapper.sh

# Check wrapper has execute permissions
docker exec ryasai-chatbot stat /var/mcp/isolated/org-*/.mcp-wrapper.sh

# Verify bash is available in container
docker exec ryasai-chatbot which bash
```

### Issue 4: Cross-Org Access Logged

**Symptom**: Console shows `"Cross-org access attempt blocked"` messages

This is actually **GOOD** - it means isolation is working! But check why requests are happening:

```bash
# Search logs
docker logs ryasai-chatbot --since 1h | grep "Cross-org" | wc -l

# Too many (>10/hour) = bug in tenant scoping
# Normal (<5/hour) = occasional edge cases
```

**Investigate**: Look at API routes that aren't setting org context correctly.

### Issue 5: Disk Space Growing Fast

**Symptom**: Container disk usage increasing rapidly

**Monitor**:
```bash
# Check sandbox usage
docker exec ryasai-chatbot du -sh /var/mcp/isolated/*

# Cleanup old npm cache
docker exec ryasai-chatbot find /var/mcp/isolated/*/npx-cache -atime +30 -delete

# Set storage quota via cgroups
docker update --memory 2g ryasai-chatbot
```

## Performance Optimization for Docker

### 1. Pre-pull Base Node Image

Reduce cold-start overhead:
```bash
docker pull node:22-alpine
```

### 2. Optimize Volume Mounting

Use named volumes instead of bind mounts for performance:
```yaml
volumes:
  mcp-sandbox:
    driver: local
    driver_opts:
      type: none
      device: /var/mcp/isolated
      o: bind
```

### 3. Enable Read-Only Root Where Possible

```yaml
services:
  ryasai-chatbot:
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=128m
```

Note: Requires adjusting all writable paths appropriately.

## Monitoring & Alerting

### Container Health Checks

Add to docker-compose.yml:
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

### Monitor Disk Usage

```bash
# Daily cron job
crontab -e
# Add:
0 */6 * * * docker exec ryasai-chatbot du -sh /var/mcp/isolated/* > /tmp/mcp-disk-usage.log 2>&1
```

### Log Aggregation

Centralize logs with tools like ELK stack or Loki:
```bash
# Configure container logging
docker update --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-files=5 \
  ryasai-chatbot
```

## Rollback Procedure

If issues arise, rollback takes 2 steps:

### Step 1: Revert Code
```bash
docker pull ryasai/chatbot:previous-version-tag
docker compose down
docker compose up -d
```

### Step 2: Clean Up Sandboxes (Optional)
```bash
# Stop all containers accessing sandbox
docker stop ryasai-chatbot

# Remove sandbox data
rm -rf /var/mcp/isolated/*

# Recreate with original code
git reset HEAD~1
docker compose build
docker compose up -d
```

## Post-Deployment Checklist

After deployment, verify:

- [ ] ✓ All org directories exist: `ls /var/mcp/isolated/org-*`
- [ ] ✓ Permissions are correct: `stat -c '%a' /var/mcp/isolated/org-*` (should be 700)
- [ ] ✓ MCP servers list successfully: `curl /api/mcp/servers`
- [ ] ✓ No cross-org access logged
- [ ] ✓ Disk usage stable (~50MB per org baseline)
- [ ] ✓ Startup time acceptable (<2 seconds additional)

## Next Steps

Once deployed, consider Phase 2 enhancements:

1. **Resource Quotas** - Limit CPU/memory per org
2. **Network Policies** - Restrict outbound connections from MCP servers
3. **Audit Dashboards** - Visualize org-level activity
4. **Automated Cleanup** - Delete unused org sandboxes after 90 days

## Support

If you encounter issues:

1. **Collect diagnostics**:
```bash
docker logs ryasai-chatbot --tail 100 > error.log
docker exec ryasai-chatbot cat /var/mcp/isolated/.debug.json > debug.json
du -sh /var/mcp/isolated/* >> disk_usage.txt
```

2. **Share logs with team** for debugging

---

**Status**: Production-ready for Docker environments  
**Risk Level**: Low (containerized, easy rollback)  
**Estimated Downtime**: ~1 minute (container restart only)
