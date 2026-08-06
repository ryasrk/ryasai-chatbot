/**
 * Migration script: Create sandbox directories for all existing organizations
 * Run this ONCE during deployment to set up org-level isolation infrastructure
 */
import { db } from '@/lib/db'
import { ensureOrganizationalSandbox } from '@/lib/mcp-sandbox'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'node:fs'

const EXEC = promisify(exec)

interface OrgStats {
  organizationId: string
  serverCount: number
}

async function main() {
  console.log('🔄 Starting MCP sandbox migration...\n')
  
  // Step 1: Get all organizations with MCP servers
  console.log('📊 Scanning for organizations with MCP servers...')
  const orgServers = await db.mcpServer.groupBy({
    by: ['organizationId'],
    _count: true,
    
  })
  
  const orgGroups = orgServers.reduce((acc, row) => {
    if (!acc[row.organizationId]) {
      acc[row.organizationId] = { organizationId: row.organizationId, serverCount: 0 }
    }
    acc[row.organizationId].serverCount++
    return acc
  }, {} as Record<string, OrgStats>)
  
  const orgIds = Object.keys(orgGroups)
  
  if (orgIds.length === 0) {
    console.log('✅ No MCP servers found - nothing to migrate\n')
    return
  }
  
  console.log(`Found ${orgIds.length} organizations with ${Object.values(orgGroups).reduce((sum, o) => sum + o.serverCount, 0)} total servers\n`)
  
  // Step 2: Pre-check base directory
  const BASE_DIR = '/var/mcp/isolated'
  if (!existsSync(BASE_DIR)) {
    console.log(`❌ Base directory not found: ${BASE_DIR}`)
    console.log('   Run: sudo ./scripts/setup-mcp-sandbox.sh\n')
    process.exit(1)
  }
  
  // Step 3: Create sandboxes for each organization
  let successCount = 0
  let failCount = 0
  
  for (const orgId of orgIds) {
    try {
      process.stdout.write(`Creating sandbox for org: ${orgId.slice(0, 8)}... `)
      
      await ensureOrganizationalSandbox(orgId)
      
      // Verify creation
      const path = `/var/mcp/isolated/org-${orgId}`
      try {
        const { stdout } = await EXEC(`stat -c '%a' ${path} 2>/dev/null || echo "NOT_FOUND"`)
        const perms = stdout.trim()
        
        if (perms !== 'NOT_FOUND' && parseInt(perms) === 700) {
          successCount++
          console.log(`✅ (${perms})`)
        } else {
          failCount++
          console.log(`⚠️ Created but permissions mismatch: ${perms}`)
        }
      } catch {
        failCount++
        console.log(`⚠️ Created (can't verify permissions)`)
      }
      
    } catch (error) {
      failCount++
      console.error(`❌ Failed:`, error instanceof Error ? error.message : String(error))
    }
  }
  
  // Step 4: Summary
  console.log('\n' + '='.repeat(60))
  console.log('MIGRATION SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total organizations: ${orgIds.length}`)
  console.log(`Success: ✅ ${successCount}`)
  console.log(`Failed: ❌ ${failCount}`)
  console.log('\nNext steps:')
  console.log('  1. Verify application started correctly')
  console.log('  2. Test MCP server connections per organization')
  console.log('  3. Monitor logs for cross-org access attempts')
  console.log('='.repeat(60))
  
  // Exit with appropriate code
  process.exit(failCount > 0 ? 1 : 0)
}

// Handle errors gracefully
main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
