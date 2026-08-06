# Migration Guide: Adding Org-Level Sandbox Isolation

This guide helps you transition your existing ryasai-chatbot installation to use organizational sandbox isolation without downtime or data loss.

## Pre-Migration Checklist

### 1. Backup Everything

```bash
# Backup database
pg_dump -h <host> -U <user> -d ryasai_chatbot > backup_$(date +%Y%m%d).sql

# Backup existing MCP server data
sudo cp -r /var/mcp/isolated /var/mcp/isolated.backup.$(date +%Y%m%d)

# Export current MCP server configurations
curl -u admin:password http://localhost:3000/api/mcp/servers \
  --output mcp-servers-export.json

# Save environment variables
cat .env > .env.backup.$(date +%Y%m%d)
```

### 2. Verify Prerequisites

Ensure your server has:
- ✅ Node.js installed (typically root or system user)
- ✅ Write permissions to `/var` directory
- ✅ Database connection intact
- ✅ Application is running

### 3. Document Current State

```bash
# Check current MCP server count
psql -h <host> -U <user> -d ryasai_chatbot <<'EOF'
SELECT 
  COUNT(*) as total_servers,
  organization_id,
  COUNT(*) FILTER (WHERE transport = 'stdio') as stdio_count,
  COUNT(*) FILTER (WHERE transport = 'sse') as sse_count,
  COUNT(*) FILTER (WHERE transport = 'http') as http_count
FROM "McpServer"
GROUP BY organization_id
ORDER BY organization_id;
EOF
```

## Migration Steps

### Step 1: Install Dependencies

If you haven't already, pull the updated code:

```bash
cd /path/to/ryasai-chatbot
git pull origin main
bun install
```

Verify new files are present:
```bash
ls -la src/lib/mcp-sandbox.ts
ls -la scripts/setup-mcp-sandbox.sh
```

### Step 2: Run Setup Script

Create the base sandbox infrastructure:

```bash
sudo chmod +x scripts/setup-mcp-sandbox.sh
sudo ./scripts/setup-mcp-sandbox.sh
```

This creates:
- `/var/mcp/isolated/` with restricted permissions
- Systemd timer for cleanup
- Proper ownership setup

### Step 3: Create Sandboxes for Existing Organizations

You need to pre-create sandboxes for all organizations that have MCP servers:

```typescript
// Create script: scripts/migrate-existing-orgs.ts
import { db } from '@/lib/db'
import { ensureOrganizationalSandbox } from '@/lib/mcp-sandbox'
import { exec } from 'child_process'
import { promisify } from 'util'

const EXEC = promisify(exec)

async function migrateExistingOrganizations() {
  console.log('🔄 Scanning for organizations with MCP servers...')
  
  const orgServers = await db.mcpServer.groupBy({
    by: ['organizationId'],
    _count: true,
  })
  
  const orgIds = [...new Set(orgServers.map(o => o.organizationId))]
  
  console.log(`Found ${orgIds.length} organizations with MCP servers\n`)
  
  for (const orgId of orgIds) {
    try {
      console.log(`Creating sandbox for org: ${orgId}`)
      await ensureOrganizationalSandbox(orgId)
      
      // Log the created path
      const path = `/var/mcp/isolated/org-${orgId}`
      console.log(`✅ Created: ${path}`)
      
      // Verify permissions
      const { stdout } = await EXEC(`stat -c '%a %U:%G' ${path}`)
      console.log(`   Permissions: ${stdout.trim()}\n`)
      
    } catch (error) {
      console.error(`❌ Failed to create sandbox for ${orgId}:`, error)
    }
  }
  
  console.log('\n🎉 Migration complete! All organization sandboxes created.')
}

migrateExistingOrganizations().catch(console.error)
```

Run the migration:
```bash
cd /path/to/ryasai-chatbot
bun run scripts/migrate-existing-orgs.ts
```

### Step 4: Update Environment Configuration

Add sandbox configuration to your `.env`:

```bash
# Add these lines to your .env file
MCP_SANDBOX_DIR=/var/mcp/isolated
MCP_MAX_CONNECTIONS_PER_ORG=20
MCP_CONNECT_TIMEOUT_MS=15000
MCP_LIST_TOOLS_TIMEOUT_MS=10000
MCP_CALL_TOOL_TIMEOUT_MS=30000
```

### Step 5: Restart Application

Stop the current instance and restart with new code:

```bash
# Stop current instance
Ctrl+C  # or systemctl stop ryasai-chatbot

# Clear Next.js cache to ensure fresh build
rm -rf .next/cache

# Start application
bun run start
```

Or if using systemd:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ryasai-chatbot
sudo systemctl status ryasai-chatbot
```

### Step 6: Verify Migration Success

Run validation checks:

```typescript
// Verify org isolation is active
curl -u admin:password http://localhost:3000/api/mcp/servers
```

Expected output should show all servers belong to their correct orgs.

Check logs for any cross-org access warnings:
```bash
tail -f /var/log/ryasai-chatbot/*.log | grep "mcp-security\|Cross-org"
```

### Step 7: Test Individual Organizations

Have users in each organization test their MCP servers:

1. User logs in as `admin@org-a@example.com`
2. Navigates to Tools → MCP Servers
3. Clicks "Test" on an installed server
4. Verifies connection works

Document success/failure per org:

```
Organization | Server Count | Test Result | Notes
-------------|--------------|-------------|------
org-abc123   | 5            | ✅ Pass     | Weather server working
org-def456   | 3            | ✅ Pass     | Postgres OK
org-ghi789   | 2            | ⚠️ Issues   | Google Drive needs re-auth
```

## Handling Issues During Migration

### Issue 1: Cross-Org Access Errors Appear

**Symptom**: Logs show `"Cross-org access blocked"` errors after restart

**Cause**: Some code paths aren't setting org context correctly

**Fix**: Find and update the caller to use proper tenant scoping:

```typescript
// BEFORE (wrong):
await listMcpTools()

// AFTER (correct):
enterWithOrg(context.orgId)  // Ensure org is set first
await listMcpTools()
```

### Issue 2: Wrapper Scripts Not Found

**Symptom**: MCP connection fails with "bash: command not found"

**Cause**: Wrapper script not generated during transport build

**Fix**: Verify `buildTransport()` is being called with org context:

```typescript
// Debug log
console.log('[mcp] Building transport for:', row.id)
const sandbox = await ensureOrganizationalSandbox(orgId)
console.log('[mcp] Sandbox path:', sandbox.sandboxPath)
```

### Issue 3: Permission Denied Errors

**Symptom**: `EACCES: permission denied` when accessing sandbox dirs

**Fix**: Recreate directories with proper ownership:

```bash
sudo chown -R node:node /var/mcp/isolated
sudo find /var/mcp/isolated -type d -exec chmod 700 {} \;
sudo find /var/mcp/isolated -name '.mcp-wrapper.sh' -exec chmod 755 {} \;
```

### Issue 4: npm Packages Already Installed Globally

**Symptom**: Installation tries to reinstall packages that exist system-wide

**Fix**: This is actually fine - they'll be copied to org-specific cache. The wrapper script ensures npm uses the org cache prefix.

## Post-Migration Cleanup

### 1. Archive Old Backup

After confirming everything works for 1 week:

```bash
mv /var/mcp/isolated.backup.* /var/mcp/archives/
```

### 2. Monitor Resource Usage

Track disk space and memory:

```bash
# Check sandbox sizes daily
du -sh /var/mcp/isolated/org-*/

# Check memory overhead
ps aux | grep mcp-wrapper

# Monitor connection counts per org
curl http://localhost:3000/admin/mcp-stats
```

### 3. Enable Monitoring Alerts

Set up alerts for:
- Cross-org access attempts > 10/hour
- Sandbox creation failures
- Connection timeout spikes

## Rollback Plan

If migration fails and you need to revert:

### Option 1: Quick Rollback (Database Only)

Restore from backup:

```bash
# Stop app
sudo systemctl stop ryasai-chatbot

# Restore database
pg_dump_restore backup_*.sql

# Remove sandbox code temporarily
mv src/lib/mcp-sandbox.ts src/lib/mcp-sandbox.ts.disabled

# Revert mcp-client.ts changes manually (restore git version)
git checkout HEAD~N src/lib/mcp-client.ts

# Restart
sudo systemctl start ryasai-chatbot
```

### Option 2: Full Rollback

```bash
# Stop app
sudo systemctl stop ryasai-chatbot

# Revert ALL migrations
git stash

# Restore old backups
rm -rf /var/mcp/isolated
mv /var/mcp/isolated.backup.*/* /var/mcp/ 2>/dev/null || true

# Start with original code
sudo systemctl start ryasai-chatbot
```

## Migration Timeline Estimate

| Task | Time | Can Parallelize? |
|------|------|------------------|
| Backup & documentation | 10 min | ✅ Yes |
| Install dependencies | 5 min | ✅ Yes |
| Run setup script | 5 min | ✅ Yes |
| Create org sandboxes | 2 min | ✅ Yes |
| Update env config | 1 min | ✅ Yes |
| Restart application | 1 min | ❌ No |
| Verification testing | 30+ min | ❌ Sequential |

**Total**: ~50 minutes for small org (<10 orgs), ~2 hours for large (>100 orgs)

## Success Criteria

✅ All organizations can see their MCP servers  
✅ No cross-org access logged in production  
✅ MCP servers connect successfully when tested  
✅ npm packages install to org-specific caches  
✅ Disk usage grows predictably (~50MB per org)  
✅ Users report no change in functionality  

## Next Steps After Migration

1. **Enable resource quotas** (Phase 2) - Limit CPU/memory per org
2. **Add network restrictions** - Restrict outbound connections from stdio servers
3. **Implement audit dashboards** - Visualize org-level MCP usage
4. **Monitor performance** - Compare latency before/after

## Support

If you encounter issues:

1. Check logs: `journalctl -u ryasai-chatbot -f`
2. Verify sandbox permissions: `ls -la /var/mcp/isolated/`
3. Test org context: `console.log(getOrgContext())` in API route
4. Review migration checklist above
