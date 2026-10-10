import { environment } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/types.ts";
import {
  emptyLibrary,
  libraryKey,
  type ChannelLibrary,
  type LibraryIdentity,
  type LibraryMutation,
} from "./model.ts";
import { createChannelLibraryStore } from "./store.ts";

const store = createChannelLibraryStore(environment.supportPath);
export function useChannelLibrary({
  identity,
  conversations,
  directoryComplete,
  legacyFavorites,
}: {
  identity: LibraryIdentity;
  conversations: Conversation[];
  directoryComplete: boolean;
  legacyFavorites: string[];
}) {
  const key = libraryKey(identity);
  const [state, setState] = useState(() => ({
    key,
    library: emptyLibrary(identity),
    ready: false,
    loaded: false,
    error: "",
  }));
  const active = useRef(key);
  active.current = key;
  const generation = useRef(0);
  const inputs = useRef({
    identity,
    conversations,
    directoryComplete,
    legacyFavorites,
  });
  inputs.current = {
    identity,
    conversations,
    directoryComplete,
    legacyFavorites,
  };
  const reload = useCallback(async () => {
    const id = ++generation.current;
    const current = inputs.current;
    const scope = libraryKey(current.identity);
    try {
      const result = await store.initialize(
        current.identity,
        current.conversations,
        current.directoryComplete,
        current.legacyFavorites,
      );
      if (active.current === scope && generation.current === id)
        setState({ key: scope, ...result, loaded: true, error: "" });
    } catch (error) {
      if (active.current === scope && generation.current === id)
        setState((old) => ({
          ...(old.key === scope
            ? old
            : {
                key: scope,
                library: emptyLibrary(current.identity),
                ready: false,
              }),
          loaded: true,
          error:
            error instanceof Error
              ? error.message
              : "整理データを保存できませんでした。再試行してください",
        }));
    }
  }, []);
  const directoryKey = conversations
    .map((c) => `${c.id}:${c.type}`)
    .sort()
    .join(",");
  const legacyKey = [...legacyFavorites].sort().join(",");
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [key, directoryComplete, directoryKey, legacyKey, reload]);
  const mutate = useCallback(
    async (mutation: LibraryMutation): Promise<ChannelLibrary | false> => {
      const current = inputs.current.identity;
      const scope = libraryKey(current);
      const id = ++generation.current;
      try {
        const library = await store.mutate(current, mutation);
        if (active.current === scope && generation.current === id)
          setState({
            key: scope,
            library,
            ready: true,
            loaded: true,
            error: "",
          });
        return active.current === scope && generation.current === id
          ? library
          : false;
      } catch (error) {
        if (active.current === scope && generation.current === id)
          setState((old) => ({
            ...old,
            error:
              error instanceof Error
                ? error.message
                : "整理データを保存できませんでした。再試行してください",
          }));
        return false;
      }
    },
    [],
  );
  return {
    library: state.key === key ? state.library : emptyLibrary(identity),
    ready: state.key === key && state.ready,
    loaded: state.key === key && state.loaded,
    error: state.key === key ? state.error : "",
    mutate,
    reload,
  };
}
