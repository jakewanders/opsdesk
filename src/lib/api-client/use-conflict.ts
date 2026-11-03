"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notify } from "@/components/shared/toast";
import {
  analyzeConflict,
  mergeOnTop,
  summarizeMine,
  type ConflictAnalysis,
  type FormSnapshot,
} from "./conflict";

export type Version = string | number;

export type ConflictState<V extends FormSnapshot> =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      analysis: ConflictAnalysis;
      latest: V;
      version: Version;
    };

type Options<V extends FormSnapshot> = {
  /** The editable fields, in display order, and their names in words. Derived fields (a picked customer's name) are left out. */
  labels: Partial<Record<keyof V & string, string>>;
  /** The version-of-the-form the person started from (what the form was last reset to). */
  getBaseline: () => V;
  /** What is in the form right now. */
  getMine: () => V;
  /**
   * Reads the record as it is now. Return `null` when the page was left instead (a quote that is no longer a draft sends the person
   * to its page). Throw when it cannot be read.
   */
  loadLatest: () => Promise<{ values: V; version: Version } | null>;
  /** Put values into the form and remember the version the next save must send. `merge` leaves the form dirty: it is not saved yet. */
  apply: (values: V, version: Version, how: "reload" | "merge", latest: V) => void;
};

/**
 * The one way a form answers a 409. `report()` is called when the save came back `STALE_EDIT`: it reads the latest record and works out
 * what changed. The form renders `<ConflictDialog>` from the result, which offers Reload latest (discard mine), Apply my changes on top
 * (only when nobody and I changed the same field), Keep editing (the form is untouched and the next save conflicts again rather than
 * overwrite), and Copy my changes.
 */
export function useConflict<V extends FormSnapshot>(options: Options<V>) {
  const [state, setState] = useState<ConflictState<V> | null>(null);
  const opts = useRef(options);
  // the latest options, for callbacks that run after the render that created them
  useEffect(() => {
    opts.current = options;
  });

  const report = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const latest = await opts.current.loadLatest();
      if (!latest) {
        setState(null);
        return;
      }
      const analysis = analyzeConflict(
        opts.current.getBaseline(),
        opts.current.getMine(),
        latest.values,
        Object.keys(opts.current.labels) as (keyof V & string)[],
      );
      setState({ status: "ready", analysis, latest: latest.values, version: latest.version });
    } catch {
      setState({ status: "failed" });
    }
  }, []);

  const close = useCallback(() => setState(null), []);

  const reloadLatest = useCallback(() => {
    setState((s) => {
      if (s?.status !== "ready") return s;
      opts.current.apply(s.latest, s.version, "reload", s.latest);
      notify.info("Loaded the latest version", "Your changes were discarded.");
      return null;
    });
  }, []);

  const applyOnTop = useCallback(() => {
    setState((s) => {
      if (s?.status !== "ready" || !s.analysis.canApplyOnTop) return s;
      const merged = mergeOnTop(s.latest, opts.current.getMine(), s.analysis.mine);
      opts.current.apply(merged, s.version, "merge", s.latest);
      notify.info("Your changes are on the latest version", "Review them, then save.");
      return null;
    });
  }, []);

  const copyMine = useCallback(async () => {
    const s = state;
    if (s?.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(
        summarizeMine(
          opts.current.labels as Record<string, string>,
          opts.current.getMine(),
          s.analysis.mine,
        ),
      );
      notify.success("Your changes were copied", "Paste them somewhere safe before you reload.");
    } catch {
      notify.error(
        "Your changes could not be copied",
        "Select the text in the form and copy it yourself.",
      );
    }
  }, [state]);

  return { state, report, close, reloadLatest, applyOnTop, copyMine };
}
