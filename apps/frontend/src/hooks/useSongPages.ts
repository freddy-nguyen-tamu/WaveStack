import { useApolloClient } from "@apollo/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { SONG_PAGE_QUERY } from "../api";
import type { Song } from "../App";

type SongPage = {
  nodes: Song[];
  totalCount: number;
  pageInfo: { endCursor?: string | null; hasNextPage: boolean };
};

// Each list owns its pages: background library queries cannot replace its cursor or rows.
export function useSongPages(query: string, sort: string, first: number, enabled = true) {
  const client = useApolloClient();
  const [page, setPage] = useState<SongPage>();
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);
  const controllerRef = useRef<AbortController>();
  const pageRef = useRef(page);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const version = ++generation.current;
    pageRef.current = undefined;
    busy.current = enabled;
    setLoading(enabled);
    setError("");
    if (!enabled) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    void client.query<{ songPage: SongPage }>({
      query: SONG_PAGE_QUERY,
      variables: { query: query || null, sort, first, after: null },
      fetchPolicy: "no-cache",
      context: { queryDeduplication: false, fetchOptions: { signal: controller.signal } }
    }).then(({ data }) => {
      if (generation.current !== version) return;
      pageRef.current = data.songPage;
      setPage(data.songPage);
    }).catch((reason: unknown) => {
      if (generation.current === version) setError(reason instanceof Error ? reason.message : "Could not load songs.");
    }).finally(() => {
      if (generation.current !== version) return;
      busy.current = false;
      setLoading(false);
    });
    return () => { generation.current += 1; controllerRef.current?.abort(); };
  }, [client, query, sort, first, enabled, revision]);

  const loadMore = useCallback(async () => {
    const previous = pageRef.current;
    if (!enabled || busy.current || !previous?.pageInfo.hasNextPage || !previous.pageInfo.endCursor) return;
    const version = generation.current;
    busy.current = true;
    setLoading(true);
    setError("");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const { data } = await client.query<{ songPage: SongPage }>({
        query: SONG_PAGE_QUERY,
        variables: { query: query || null, sort, first, after: previous.pageInfo.endCursor },
        fetchPolicy: "no-cache",
        context: { queryDeduplication: false, fetchOptions: { signal: controller.signal } }
      });
      if (generation.current !== version) return;
      const seen = new Set(previous.nodes.map(song => song.id));
      const next = { ...data.songPage, nodes: [...previous.nodes, ...data.songPage.nodes.filter(song => !seen.has(song.id))] };
      pageRef.current = next;
      setPage(next);
    } catch (reason) {
      if (generation.current === version) setError(reason instanceof Error ? reason.message : "Could not load more songs.");
    } finally {
      if (generation.current === version) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [client, query, sort, first, enabled]);

  return { page, loading, error, loadMore, retry: () => {
    if (pageRef.current) void loadMore();
    else setRevision(value => value + 1);
  } };
}
