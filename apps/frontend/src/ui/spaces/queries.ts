import {
  keepPreviousData,
  noop,
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect } from 'react'

import type {
  NewSpace,
  ShelfState,
  ShelvedSpace,
  Space,
  SpaceApp,
  SpaceChange,
  SpaceSummary,
  SpacesService
} from '@/application/spaces'
import { useServices } from '@/ui/services/Services'

export const SPACES = ['spaces']

export function useSpaceList(): UseQueryResult<SpaceSummary[]> {
  const { spaces } = useServices()
  return useQuery({ queryKey: SPACES, queryFn: () => spaces.list() })
}

export function useSpace(id: string): UseQueryResult<Space> {
  const { spaces } = useServices()
  return useQuery({
    queryKey: [...SPACES, id],
    queryFn: () => spaces.get(id),
    enabled: id !== ''
  })
}

/**
 * Reads a space in full, from the cache `useSpace` shares while it is recent
 * and not invalidated by a live change.
 */
export function useFetchSpace(): (id: string) => Promise<Space> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return id =>
    queryClient.query({
      queryKey: [...SPACES, id],
      queryFn: () => spaces.get(id),
      staleTime: 30_000,
      retry: false
    })
}

// The spaces of the list in full, from the cache `useSpace` shares. Read
// only when `enabled`.
export function useSpaces(
  ids: string[],
  enabled: boolean
): UseQueryResult<Space>[] {
  const { spaces } = useServices()
  return useQueries({
    queries: ids.map(id => ({
      queryKey: [...SPACES, id],
      queryFn: () => spaces.get(id),
      enabled
    }))
  })
}

// Apart from SPACES and kept as long as its version, so that no write to the
// space fetches the image again. A data URL, unlike an object URL, needs no
// revoking. A new version keeps the old image up until its own is in.
export function useBanner(space: Space): string | undefined {
  const { spaces } = useServices()
  const { data } = useQuery({
    ...bannerQuery(spaces, space),
    enabled: space.banner !== null,
    placeholderData: keepPreviousData
  })
  return space.banner === null ? undefined : data
}

function bannerQuery(spaces: SpacesService, space: Space) {
  return queryOptions({
    queryKey: ['banners', space.id, space.banner],
    queryFn: async () => dataUrl(await spaces.banner(space.id)),
    staleTime: Infinity
  })
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(reader.result as string)
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('could not read the banner'))
    }
    reader.readAsDataURL(blob)
  })
}

export function useSetBanner(id: string): UseMutationResult<void, Error, Blob> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: image => spaces.setBanner(id, image),
    // Pending until the new image is in the cache, so that the upload reads
    // as done only once the banner shows it.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...SPACES, id] })
      const space = queryClient.getQueryData<Space>([...SPACES, id])
      if (space !== undefined && space.banner !== null)
        await queryClient
          .query({ ...bannerQuery(spaces, space), retry: false })
          .catch(noop)
    },
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: [...SPACES, id] })
  })
}

export function useSpaceApps(): UseQueryResult<SpaceApp[]> {
  const { spaces } = useServices()
  return useQuery({
    queryKey: [...SPACES, 'apps'],
    queryFn: () => spaces.apps()
  })
}

// The copy changes once the backend applies ldap-rest's answer, so the space
// is read again after every write, refused or not.
export function useSpaceWrite(
  id: string
): UseMutationResult<void, Error, (spaces: SpacesService) => Promise<void>> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write => write(spaces),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [...SPACES, id] })
  })
}

export function useEditSpace(
  id: string
): UseMutationResult<void, Error, SpaceChange> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: change => spaces.edit(id, change),
    // The list shows the name too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: SPACES })
  })
}

export function useDeleteSpace(id: string): UseMutationResult<void> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => spaces.remove(id),
    onSuccess: () => {
      // Refetching it would only answer 404 before the page moves away.
      queryClient.removeQueries({ queryKey: [...SPACES, id] })
      return queryClient.invalidateQueries({ queryKey: SPACES })
    }
  })
}

// Under SPACES, so that live updates read them again too.
export function useShelved(state: ShelfState): UseQueryResult<ShelvedSpace[]> {
  const { spaces } = useServices()
  return useQuery({
    queryKey: [...SPACES, 'shelved', state],
    queryFn: () => spaces.shelved(state)
  })
}

export function useSetState(
  id: string
): UseMutationResult<void, Error, ShelfState | 'active'> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: state => spaces.setState(id, state),
    onSuccess: () => {
      // Out of reach once archived or in the Bin.
      queryClient.removeQueries({ queryKey: [...SPACES, id] })
      return queryClient.invalidateQueries({ queryKey: SPACES })
    }
  })
}

export function useEmptyBin(): UseMutationResult<void> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => spaces.emptyBin(),
    // A failure halfway still deleted some.
    onSettled: () => queryClient.invalidateQueries({ queryKey: SPACES })
  })
}

export function useSetPinned(
  id: string
): UseMutationResult<void, Error, boolean> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: pinned => spaces.setPinned(id, pinned),
    onSettled: () => queryClient.invalidateQueries({ queryKey: SPACES })
  })
}

// Recent follows each space shown. A visit that fails to be recorded only
// leaves Recent behind, so it is not reported.
export function useMarkOpened(id: string, shown: boolean): void {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!shown) return
    spaces
      .markOpened(id)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: SPACES, exact: true })
      )
      .catch(() => undefined)
  }, [id, shown, spaces, queryClient])
}

export function useCreateSpace(): UseMutationResult<
  SpaceSummary,
  Error,
  NewSpace
> {
  const { spaces } = useServices()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: space => spaces.create(space),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SPACES })
  })
}
