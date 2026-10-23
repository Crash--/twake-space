import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { useServices } from '@/ui/services/Services'
import { FEED_NEWS, followFeedChange } from '@/ui/space/feedQueries'
import { SUGGESTIONS } from '@/ui/assistant/queries'
import { SPACES } from '@/ui/spaces/queries'

export function useLiveUpdates(): void {
  const { live, feed } = useServices()
  const queryClient = useQueryClient()

  useEffect(
    () =>
      live.subscribe({
        onEvent: (event, data) => {
          if (event === 'spaces') {
            void queryClient.invalidateQueries({ queryKey: SPACES })
          }
          if (event === 'notification') {
            void queryClient.invalidateQueries({ queryKey: SUGGESTIONS })
            void queryClient.invalidateQueries({ queryKey: FEED_NEWS })
          }
          if (event === 'feed') {
            followFeedChange(queryClient, feed, data)
            void queryClient.invalidateQueries({ queryKey: FEED_NEWS })
          }
        },
        onReconnect: () => void queryClient.invalidateQueries()
      }),
    [live, feed, queryClient]
  )
}
