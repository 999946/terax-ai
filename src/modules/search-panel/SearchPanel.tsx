import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAsyncQuery } from "@/modules/command-palette/hooks/useAsyncQuery";
import { cn } from "@/lib/utils";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { replaceInFiles, searchInFiles, type ContentHit } from "./native";
import { useSearchPanel } from "./useSearchPanel";

const MIN_QUERY = 1;
const DEBOUNCE_MS = 140;
const LIMIT = 200;

/**
 * Bottom-docked cross-file find & replace panel (WebStorm interaction).
 * Fixed overlay docked just above the StatusBar (h-8); results group by file
 * and clicking a hit opens the file at that line via the existing navigation.
 */
export function SearchPanel({
  root,
  onOpenContentHit,
}: {
  root: string | null;
  onOpenContentHit: (path: string, line: number) => void;
}) {
  const { t } = useTranslation();
  const { open, replaceMode, query, replacement, matchCase, regex } =
    useSearchPanel();
  const setQuery = useSearchPanel((s) => s.setQuery);
  const setReplacement = useSearchPanel((s) => s.setReplacement);
  const setMatchCase = useSearchPanel((s) => s.setMatchCase);
  const setRegex = useSearchPanel((s) => s.setRegex);
  const setReplaceMode = useSearchPanel((s) => s.setReplaceMode);
  const closePanel = useSearchPanel((s) => s.closePanel);

  const { results, loading, error, retry } = useAsyncQuery<ContentHit>({
    enabled: open && !!root,
    term: query,
    minLength: MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run: (q) =>
      searchInFiles({
        root: root ?? "",
        query: q,
        regex,
        matchCase,
        maxResults: LIMIT,
      }),
  });

  const groups = useMemo(() => {
    const m = new Map<string, ContentHit[]>();
    for (const hit of results) {
      const arr = m.get(hit.path);
      if (arr) arr.push(hit);
      else m.set(hit.path, [hit]);
    }
    return [...m.entries()];
  }, [results]);

  // Re-run the current query when a toggle (matchCase / regex) flips — the
  // query hook only reacts to the term, not to these flags.
  useEffect(() => {
    if (open && query.trim().length >= MIN_QUERY) retry();
  }, [matchCase, regex]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startConfirm = () => {
    setConfirming(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirming(false), 4000);
  };

  const runReplaceAll = async () => {
    if (!root || !query.trim()) return;
    setConfirming(false);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    try {
      const res = await replaceInFiles({
        root,
        query,
        replacement,
        regex,
        matchCase,
      });
      toast.success(
        t("search.replaceComplete", {
          replacements: res.replacements,
          files: res.files_changed,
        }),
      );
    } catch (e) {
      toast.error(t("search.replaceFailed", { error: String(e) }));
    }
  };

  const matchCount = results.length;
  const fileCount = groups.length;

  // Escape closes the panel from anywhere inside it (input included).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePanel]);

  const toggleBtn = (active: boolean) =>
    cn(
      "h-7 shrink-0 rounded-lg px-2 text-[11px] font-medium transition-colors",
      active
        ? "bg-foreground/10 text-foreground"
        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
    );

  return (
    <div
      data-search-panel
      className="fixed inset-x-0 bottom-8 z-50 flex flex-col border-t border-border/70 bg-background/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.4)] backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      {/* Top bar: query + toggles */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 px-3">
        <HugeiconsIcon
          icon={Search01Icon}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") retry();
          }}
          placeholder={t("search.findInput")}
          className="h-7 flex-1 rounded-lg"
        />
        <button
          type="button"
          className={toggleBtn(matchCase)}
          title={t("search.matchCase")}
          onClick={() => setMatchCase(!matchCase)}
        >
          Aa
        </button>
        <button
          type="button"
          className={toggleBtn(regex)}
          title={t("search.regex")}
          onClick={() => setRegex(!regex)}
        >
          .*
        </button>
        <button
          type="button"
          className={toggleBtn(replaceMode)}
          onClick={() => setReplaceMode(!replaceMode)}
        >
          {t("search.replaceToggle")}
        </button>
        <button
          type="button"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          onClick={closePanel}
          title={t("search.close")}
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
        </button>
      </div>

      {/* Replace row */}
      {replaceMode ? (
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-t border-border/60 px-3">
          <Input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (confirming) void runReplaceAll();
                else startConfirm();
              }
            }}
            placeholder={t("search.replaceInput")}
            className="h-7 flex-1 rounded-lg"
          />
          {confirming ? (
            <Button
              size="sm"
              className="h-7"
              onClick={() => void runReplaceAll()}
            >
              {t("search.confirmReplaceAll")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              disabled={!query.trim() || loading}
              onClick={startConfirm}
            >
              {t("search.replaceAll")}
            </Button>
          )}
        </div>
      ) : null}

      {/* Results */}
      <div className="max-h-[45vh] min-h-0 overflow-auto border-t border-border/60">
        {loading ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("search.searching")}
          </p>
        ) : error ? (
          <p className="px-3 py-2 text-[11px] text-destructive">{error}</p>
        ) : !query.trim() ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("search.noQuery")}
          </p>
        ) : groups.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("search.noResults")}
          </p>
        ) : (
          groups.map(([path, hits]) => (
            <div key={path} className="border-b border-border/40 last:border-0">
              <div className="flex items-center gap-2 bg-foreground/[0.02] px-3 py-1 text-[11px] font-medium text-muted-foreground">
                <span className="truncate">{path}</span>
                <span className="shrink-0 text-[10px] text-foreground/40">
                  {hits.length}
                </span>
              </div>
              {hits.map((hit, i) => (
                <button
                  key={`${path}:${hit.line}:${i}`}
                  type="button"
                  className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left font-mono text-[11px] hover:bg-foreground/5"
                  onClick={() => onOpenContentHit(hit.path, hit.line)}
                >
                  <span className="shrink-0 select-none text-[10px] text-muted-foreground/60">
                    {hit.line}
                  </span>
                  <span className="truncate text-foreground/80">
                    {hit.text}
                  </span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Footer stats */}
      {query.trim() && !loading ? (
        <div className="flex h-6 shrink-0 items-center justify-between border-t border-border/60 px-3 text-[10px] text-muted-foreground">
          <span>
            {t("search.results", { matches: matchCount, files: fileCount })}
          </span>
          {root ? (
            <span className="truncate pl-3">{t("search.scope", { root })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
