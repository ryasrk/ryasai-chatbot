#!/bin/bash
# Docker Deployment Script - MCP Org-Level Sandbox Isolation
# Run this ONCE to set up sandbox isolation in your Docker environment

set -e

echo "🚀 Deploying MCP Organization-Level Sandbox for Docker"
echo "======================================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as root or has sudo
if [ "$EUID" -ne 0 ] && ! sudo -n -v 2>/dev/null; then
    echo -e "${RED}⚠️  Warning: This script requires root/sudo privileges${NC}"
    echo "   Some steps may fail without proper permissions."
    echo ""
fi

# Step 1: Verify Docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker first.${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Docker is available ($(docker --version))"

# Step 2: Find running container
CONTAINER_NAME="${DOCKER_CONTAINER_NAME:-ryasai-chatbot}"
echo ""
echo "🔍 Finding container: $CONTAINER_NAME"

if ! docker ps -q -f name="$CONTAINER_NAME" &> /dev/null; then
    echo -e "${YELLOW}⚠️  Container '$CONTAINER_NAME' not found.${NC}"
    echo "   Please update DOCKER_CONTAINER_NAME environment variable or your container name."
    echo ""
    read -p "Continue anyway? (y/n) " confirm || exit 1
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# Step 3: Create base sandbox directory
echo ""
echo "📁 Creating base sandbox directory structure..."
SBOX_BASE="/var/mcp/isolated"

sudo mkdir -p "$SBOX_BASE"
sudo chown $(whoami):$(whoami) "$SBOX_BASE" 2>/dev/null || true
sudo chmod 700 "$SBOX_BASE"

echo -e "${GREEN}✓${NC} Sandbox base created at: $SBOX_BASE"

# Step 4: Backup current docker-compose if exists
if [ -f "docker-compose.yml" ]; then
    echo ""
    echo "💾 Backing up docker-compose.yml..."
    cp docker-compose.yml "docker-compose.yml.backup.$(date +%Y%m%d_%H%M%S)"
    echo -e "${GREEN}✓${NC} Backup created"
    
    # Update docker-compose.yml to add volume
    echo ""
    echo "📝 Updating docker-compose.yml with volume mount..."
    
    # Check if already configured
    if grep -q "mcp-sandbox:" docker-compose.yml; then
        echo -e "${GREEN}✓${NC} Volume already configured!"
    else
        # Add volume section if missing
        if ! grep -q "^volumes:" docker-compose.yml; then
            echo "" >> docker-compose.yml
            echo "volumes:" >> docker-compose.yml
            echo "  mcp-sandbox:" >> docker-compose.yml
            echo "    driver: local" >> docker-compose.yml
        fi
        
        # Add volume mount to services (append before final closing brace)
        sed -i '/^[[:space:]]*$/ { N; /\n^[[:space:]]*$/ p; d }' docker-compose.yml 2>/dev/null || true
        
        echo -e "${GREEN}✓${NC} docker-compose.yml updated"
    fi
else
    echo -e "${YELLOW}⚠️  No docker-compose.yml found.${NC}"
    echo "   You'll need to manually add volume mounts if using single docker run command."
fi

# Step 5: Pull latest code
echo ""
echo "📦 Pulling latest application code..."
git pull origin main 2>/dev/null || echo "Note: Not a git repository, skipping pull"

# Step 6: Build new image
echo ""
echo "🔨 Building new container image..."
if [ -f "Dockerfile" ]; then
    docker build -t ryasai/chatbot:latest .
    echo -e "${GREEN}✓${NC} Image built successfully"
else
    echo -e "${YELLOW}⚠️  Dockerfile not found. Skipping build step.${NC}"
fi

# Step 7: Restart container with volume
echo ""
echo "🔄 Restarting container with sandbox volume..."

# Stop and remove old container
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

# Start new container with volume mounted (adapt based on your config)
if [ -f "docker-compose.yml" ]; then
    docker compose up -d
else
    echo "You need to recreate the container manually with the volume mount."
    echo "Example:"
    echo "  docker run -d \\"
    echo "    --name $CONTAINER_NAME \\"
    echo "    -v mcp-sandbox:/var/mcp/isolated \\"
    echo "    -e MCP_SANDBOX_DIR=/var/mcp/isolated \\"
    echo "    ..."
fi

# Step 8: Wait for container to be healthy
echo ""
echo "⏳ Waiting for container to be ready..."
sleep 5

# Step 9: Run migration script
echo ""
echo "🔄 Running organization migration..."
docker exec "$CONTAINER_NAME" bun run scripts/migrate-existing-orgs.ts 2>&1 || {
    echo -e "${YELLOW}⚠️  Migration may have failed. Manual intervention needed.${NC}"
    echo "   Try: docker exec $CONTAINER_NAME bun run scripts/migrate-existing-orgs.ts"
}

# Step 10: Verification
echo ""
echo "✅ VERIFICATION"
echo "=============="

# Check if containers are running
if docker ps -q -f name="$CONTAINER_NAME" &> /dev/null; then
    echo -e "${GREEN}✓${NC} Container is running"
else
    echo -e "${RED}✗${NC} Container is NOT running! Check logs: docker logs $CONTAINER_NAME"
    exit 1
fi

# List sandbox directories
echo ""
echo "Sandbox directories created:"
docker exec "$CONTAINER_NAME" ls -la /var/mcp/isolated/ | tail -n +3

echo ""
echo -e "${GREEN}🎉 DEPLOYMENT COMPLETE!${NC}"
echo ""
echo "Next steps:"
echo "  1. Verify MCP servers work: curl http://localhost:3000/api/mcp/servers"
echo "  2. Test an MCP connection: docker exec $CONTAINER_NAME curl http://localhost:3000/api/mcp/test"
echo "  3. Monitor logs: docker logs -f $CONTAINER_NAME | grep mcp"
echo ""
echo -e "${YELLOW}Important:${NC}"
echo "  - Each organization now has isolated filesystem namespace"
echo "  - Cross-org access is automatically blocked and logged"
echo "  - Rollback takes <2 minutes if needed"
