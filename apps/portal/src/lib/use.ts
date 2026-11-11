import { useCallback, useEffect, useState } from "react";
/** A small fetch hook: the portal has two screens and does not need a query cache. */
export function useFetch<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const run = useCallback(() => { let live = true; setState((s) => ({ ...s, loading: true })); load().then((data) => live && setState({ data, loading: false }), (error) => live && setState({ error, loading: false })); return () => { live = false; }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => run(), [run]);
  return { ...state, reload: run };
}
