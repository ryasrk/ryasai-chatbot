'use client'

import { useState } from 'react'
import { Puzzle, Server } from 'lucide-react'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { McpServersTab } from './plugins/mcp-servers-tab'
import { CustomToolsTab } from './plugins/custom-tools-tab'

export function PluginsView() {
  const [tab, setTab] = useState('mcp')

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <Puzzle className="h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">Tools &amp; Integrations</h2>
          <p className="text-xs text-muted-foreground">
            MCP servers and custom webhook tools.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="min-h-[500px]">
        <TabsList className="w-max">
          <TabsTrigger value="mcp" className="gap-1.5 text-xs">
            <Server className="h-3.5 w-3.5" /> MCP Servers
          </TabsTrigger>
          <TabsTrigger value="custom" className="gap-1.5 text-xs">
            <Puzzle className="h-3.5 w-3.5" /> Custom Tools
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mcp" className="mt-3">
          <McpServersTab />
        </TabsContent>
        <TabsContent value="custom" className="mt-3">
          <CustomToolsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
