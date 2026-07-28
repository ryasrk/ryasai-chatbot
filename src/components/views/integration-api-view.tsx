'use client'

import { useState } from 'react'
import { BookOpen, FlaskConical, KeyRound, ScrollText } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DocumentationPanel } from './integration-api/documentation-panel'
import { TestPanel } from './integration-api/test-panel'
import { ApiKeysPanel } from './integration-api/api-keys-panel'
import { RequestLogsPanel } from './integration-api/request-logs-panel'

export function IntegrationApiView() {
  const [tab, setTab] = useState('docs')
  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <div className="overflow-x-auto -mx-1 px-1 pb-1">
        <TabsList className="w-max">
          <TabsTrigger value="docs" className="gap-1.5">
            <BookOpen className="h-3.5 w-3.5" />
            Documentation
          </TabsTrigger>
          <TabsTrigger value="test" className="gap-1.5">
            <FlaskConical className="h-3.5 w-3.5" />
            Test
          </TabsTrigger>
          <TabsTrigger value="keys" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Request Logs
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="docs" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <DocumentationPanel onSwitchTab={setTab} />
      </TabsContent>
      <TabsContent value="test" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <TestPanel />
      </TabsContent>
      <TabsContent value="keys" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <ApiKeysPanel />
      </TabsContent>
      <TabsContent value="logs" forceMount className="hidden data-[state=active]:block mt-3 space-y-3">
        <RequestLogsPanel />
      </TabsContent>
    </Tabs>
  )
}
