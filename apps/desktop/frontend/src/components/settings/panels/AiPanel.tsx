import { useCallback, useEffect, useId, useState } from "react";

import { Check, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  api,
  events,
  type AiConnectionConfig,
  type AiConnectionView,
  type AiProviderKind,
  type AiTemplateScope,
  type EmbedStatus,
} from "../../../ipc/api";
import { useAi } from "../../../stores/aiStore";
import { Select, SettingsSection, Switch, TextField } from "../../ui";

// Kinds offered in the "add" dropdown.
const ADDABLE_KINDS: AiProviderKind[] = [
  "anthropic",
  "openAiCompatible",
  "claudeCli",
  "codexCli",
];

function isCliKind(kind: AiProviderKind): boolean {
  return kind === "claudeCli" || kind === "codexCli";
}

// Static id → i18n key map for provider-kind labels (typed i18next rejects
// template-built keys). Liveness for the extractor:
// t("ai:kind.anthropic")
// t("ai:kind.openAiCompatible")
// t("ai:kind.claudeCli")
// t("ai:kind.codexCli")
const KIND_KEY = {
  anthropic: "kind.anthropic",
  openAiCompatible: "kind.openAiCompatible",
  claudeCli: "kind.claudeCli",
  codexCli: "kind.codexCli",
} as const;

// Example base URL shown as the OpenAI-compatible placeholder (a non-translatable
// hint; held in a const so the i18next jsx-only rule doesn't flag a JSX literal).
const OPENAI_BASE_HINT = "https://api.openai.com";

// Sentinel embedding "connection" that selects the bundled on-device model.
// Must match novalis_core::models::LOCAL_EMBEDDING_CONNECTION_ID /
// LOCAL_EMBEDDING_MODEL — the backend resolves these to its native embedder and
// pins the stored model id (real connections are UUIDs, so no collision).
const LOCAL_EMBED_CONN_ID = "local";
const LOCAL_EMBED_MODEL = "local:bge-small-en-v1.5";

function defaultModel(kind: AiProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "claude-opus-4-8";
    case "openAiCompatible":
      return "gpt-4o";
    default:
      return "";
  }
}

/** AI connections: add/edit/remove providers and their (write-only) API keys. */
export function AiPanel() {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const loadError = useAi((s) => s.loadError);
  const [newKind, setNewKind] = useState<AiProviderKind>("anthropic");

  useEffect(() => {
    void useAi.getState().load();
  }, []);

  const kindLabel = (k: AiProviderKind) => t(KIND_KEY[k]);

  const addConnection = () => {
    void useAi.getState().upsertConnection({
      id: crypto.randomUUID(),
      kind: newKind,
      label: kindLabel(newKind),
      baseUrl: null,
      model: defaultModel(newKind),
      enabled: true,
    });
  };

  return (
    <>
    <SettingsSection title={t("settings.title")} description={t("settings.desc")}>
      {/* A failed load must not masquerade as "no connections yet". */}
      {loadError && <p className="py-1 text-sm text-danger">{loadError}</p>}
      {connections.length === 0 ? (
        !loadError && <p className="py-1 text-sm text-fg-faint">{t("settings.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-4">
        <Select
          value={newKind}
          onChange={(v) => setNewKind(v as AiProviderKind)}
          options={ADDABLE_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
          aria-label={t("settings.addKind")}
        />
        <button
          type="button"
          onClick={addConnection}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90"
        >
          {t("settings.add")}
        </button>
      </div>
    </SettingsSection>
    <SemanticSearchSection />
    <PromptTemplatesSection />
    </>
  );
}

/** Configure + build the on-device semantic index (note embeddings). Only
 *  enabled OpenAI-compatible connections can provide embeddings; the build is
 *  the sole network/token cost, so it's an explicit, batched button. */
function SemanticSearchSection() {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const eligible = connections.filter(
    (c) => c.kind === "openAiCompatible" && c.enabled,
  );

  const [connId, setConnId] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<EmbedStatus | null>(null);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.aiEmbedStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  // Load the saved config + coverage on mount.
  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.aiEmbeddingConfig();
        if (cfg) {
          setConnId(cfg.connectionId);
          setModel(cfg.model);
        }
      } catch {
        // No engine / no config — leave the form blank.
      }
      await refreshStatus();
    })();
  }, [refreshStatus]);

  const persist = useCallback(
    async (nextConn: string, nextModel: string) => {
      setError(null);
      try {
        await api.aiSetEmbeddingConfig(nextConn, nextModel.trim());
        await refreshStatus();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshStatus],
  );

  const onConn = (v: string) => {
    setConnId(v);
    // The bundled model has a fixed id; the backend pins it regardless, but send
    // it so the saved config reads cleanly.
    void persist(v, v === LOCAL_EMBED_CONN_ID ? LOCAL_EMBED_MODEL : model);
  };

  const build = async () => {
    setBuilding(true);
    setError(null);
    setProgress(null);
    const unlisten = await events.aiEmbedProgress.listen((e) =>
      setProgress({ done: e.payload.done, total: e.payload.total }),
    );
    try {
      setStatus(await api.aiBuildEmbeddings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten();
      setBuilding(false);
      setProgress(null);
    }
  };

  // The bundled on-device model is always selectable (nothing to install); the
  // saved connection may have been disabled/removed since, so keep it selectable
  // too so the user can see (and change) what's configured.
  const connOptions = [
    { value: "", label: t("settings.embed.connectionNone") },
    { value: LOCAL_EMBED_CONN_ID, label: t("settings.embed.connectionLocal") },
    ...eligible.map((c) => ({ value: c.id, label: c.label })),
    ...(connId && connId !== LOCAL_EMBED_CONN_ID && !eligible.some((c) => c.id === connId)
      ? [{ value: connId, label: connId }]
      : []),
  ];

  const isLocal = connId === LOCAL_EMBED_CONN_ID;
  const total = progress?.total ?? status?.total ?? 0;
  const done = progress?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const upToDate = !!status?.configured && status.total > 0 && status.embedded >= status.total;

  return (
    <SettingsSection title={t("settings.embed.title")} description={t("settings.embed.desc")}>
      <div className="flex flex-col gap-3">
        {/* The form is always available now that a bundled local model exists;
            this stays as a nudge for anyone who'd rather use a cloud model. */}
        {eligible.length === 0 && (
          <p className="py-1 text-sm text-fg-faint">{t("settings.embed.noConnections")}</p>
        )}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2">
            <label className="text-xs text-fg-muted">{t("settings.embed.connection")}</label>
            <Select
              value={connId}
              onChange={onConn}
              options={connOptions}
              aria-label={t("settings.embed.connection")}
            />

            <label className="text-xs text-fg-muted">{t("settings.embed.model")}</label>
            <TextField
              // Local's model id is fixed; show it read-only.
              value={isLocal ? LOCAL_EMBED_MODEL : model}
              placeholder={t("settings.embed.modelPlaceholder")}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void persist(connId, model)}
              disabled={!connId || isLocal}
              className="w-full"
            />
          </div>

          {isLocal && (
            <p className="text-xs text-fg-faint">{t("settings.embed.localHint")}</p>
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-fg-muted">
              {status?.configured
                ? upToDate
                  ? t("settings.embed.upToDate")
                  : t("settings.embed.coverage", {
                      embedded: status.embedded,
                      total: status.total,
                    })
                : t("settings.embed.notConfigured")}
            </span>
            <button
              type="button"
              onClick={() => void build()}
              disabled={building || !status?.configured || status.total === 0}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {building ? <Loader2 size={13} className="animate-spin" /> : null}
              {building
                ? t("settings.embed.building", { done, total })
                : upToDate
                  ? t("settings.embed.rebuild")
                  : t("settings.embed.build")}
            </button>
          </div>

          {building && total > 0 && (
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    </SettingsSection>
  );
}

function PromptTemplatesSection() {
  const { t } = useTranslation("ai");
  const templates = useAi((s) => s.templates);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<AiTemplateScope>("vault");
  const [busy, setBusy] = useState(false);

  const scopeLabel = (s: AiTemplateScope) =>
    s === "global" ? t("settings.templates.scopeGlobal") : t("settings.templates.scopeVault");

  const add = async () => {
    if (!name.trim() || !body.trim()) return;
    setBusy(true);
    try {
      await useAi.getState().saveTemplate(name.trim(), body.trim(), scope);
      setName("");
      setBody("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("settings.templates.title")} description={t("settings.templates.desc")}>
      {templates.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {templates.map((tpl) => (
            <div
              key={`${tpl.scope}:${tpl.id}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-fg">{tpl.name}</span>
                  <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] text-fg-faint">
                    {scopeLabel(tpl.scope)}
                  </span>
                </div>
                <div className="truncate text-xs text-fg-faint">{tpl.body}</div>
              </div>
              <button
                type="button"
                onClick={() => void useAi.getState().deleteTemplate(tpl.id, tpl.scope)}
                aria-label={t("settings.templates.remove")}
                className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-500/10 hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <TextField
          value={name}
          placeholder={t("settings.templates.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          className="w-full"
        />
        <textarea
          value={body}
          placeholder={t("settings.templates.bodyPlaceholder")}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          className="w-full resize-none rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/50"
        />
        <div className="flex items-center justify-between gap-2">
          <Select
            value={scope}
            onChange={(v) => setScope(v as AiTemplateScope)}
            options={[
              { value: "vault", label: t("settings.templates.scopeVault") },
              { value: "global", label: t("settings.templates.scopeGlobal") },
            ]}
            aria-label={t("settings.templates.scope")}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !name.trim() || !body.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("settings.templates.add")}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

function ConnectionCard({ conn }: { conn: AiConnectionView }) {
  const { t } = useTranslation("ai");
  const modelListId = useId();
  const [label, setLabel] = useState(conn.label);
  const [model, setModel] = useState(conn.model);
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const cli = isCliKind(conn.kind);
  const showBaseUrl = conn.kind === "openAiCompatible";
  // CLI kinds reuse `baseUrl` as an optional explicit path to the binary.
  const hasUrlField = showBaseUrl || cli;

  const save = (overrides: Partial<AiConnectionConfig> = {}) => {
    const cfg: AiConnectionConfig = {
      id: conn.id,
      kind: conn.kind,
      label: label.trim() || conn.label,
      model: model.trim(),
      baseUrl: hasUrlField ? baseUrl.trim() || null : (conn.baseUrl ?? null),
      enabled: conn.enabled,
      // Preserve the agentic flag across edits (it's only toggled explicitly).
      agentic: conn.agentic,
      ...overrides,
    };
    void useAi.getState().upsertConnection(cfg);
  };

  const saveKey = async () => {
    setBusy(true);
    setTest(null);
    try {
      await api.aiSetApiKey(conn.id, keyDraft);
      setKeyDraft("");
      await useAi.getState().load(); // refresh the "configured" badge
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      await api.aiTestConnection(conn.id);
      setTest({ ok: true, message: t("settings.test.ok") });
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = () => void useAi.getState().deleteConnection(conn.id);

  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Switch
            checked={conn.enabled}
            onChange={(enabled) => save({ enabled })}
            aria-label={t("settings.enabled")}
          />
          <span className="text-[11px] uppercase tracking-wide text-fg-faint">
            {t(KIND_KEY[conn.kind])}
          </span>
          {conn.configured ? (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
              {cli ? t("settings.detected") : t("settings.configured")}
            </span>
          ) : (
            <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-fg-faint">
              {cli ? t("settings.notFound") : t("settings.notConfigured")}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={removeConnection}
          aria-label={t("settings.remove")}
          className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-500/10 hover:text-danger"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-2">
        <label className="text-xs text-fg-muted">{t("settings.label")}</label>
        <TextField
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => save()}
          className="w-full"
        />

        <label className="text-xs text-fg-muted">{t("settings.model")}</label>
        {cli ? (
          // CLI tools have their own configured model — "Default" sends no
          // --model. A previously-set custom value stays selectable.
          <Select
            value={model}
            onChange={(v) => {
              setModel(v);
              save({ model: v });
            }}
            options={[
              { value: "", label: t("settings.modelDefault") },
              ...conn.models.map((m) => ({ value: m.id, label: m.label })),
              ...(model && !conn.models.some((m) => m.id === model)
                ? [{ value: model, label: model }]
                : []),
            ]}
            aria-label={t("settings.model")}
          />
        ) : (
          <>
            <TextField
              value={model}
              list={modelListId}
              placeholder={defaultModel(conn.kind)}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => save()}
              className="w-full"
            />
            <datalist id={modelListId}>
              {conn.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </>
        )}

        {hasUrlField && (
          <>
            <label className="text-xs text-fg-muted">
              {cli ? t("settings.binaryPath") : t("settings.baseUrl")}
            </label>
            <TextField
              value={baseUrl}
              placeholder={cli ? t("settings.binaryPathPlaceholder") : OPENAI_BASE_HINT}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => save()}
              className="w-full"
            />
          </>
        )}

        {!cli && (
          <>
            <label className="text-xs text-fg-muted">{t("settings.apiKey")}</label>
            <span className="flex items-center gap-1.5">
              <TextField
                type="password"
                value={keyDraft}
                placeholder={conn.configured ? "••••••••" : t("settings.apiKeyPlaceholder")}
                onChange={(e) => setKeyDraft(e.target.value)}
                className="w-full"
              />
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={busy || (keyDraft.trim() === "" && !conn.configured)}
                className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {keyDraft.trim() === "" && conn.configured
                  ? t("settings.removeKey")
                  : t("settings.saveKey")}
              </button>
            </span>
          </>
        )}
      </div>

      {cli && <p className="mt-2 text-xs text-fg-faint">{t("settings.cliHint")}</p>}

      {cli && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 px-3 py-2">
          <Switch
            checked={conn.agentic}
            onChange={(agentic) => save({ agentic })}
            aria-label={t("settings.agentic.label")}
          />
          <div className="min-w-0">
            <div className="text-xs font-medium text-fg">{t("settings.agentic.label")}</div>
            <div className="mt-0.5 text-xs text-fg-faint">{t("settings.agentic.hint")}</div>
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={busy || (!cli && !conn.configured)}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : null}
          {t("settings.test.button")}
        </button>
        {test && (
          <span
            className={`flex items-center gap-1 text-xs ${test.ok ? "text-accent" : "text-danger"}`}
          >
            {test.ok && <Check size={13} />}
            {test.message}
          </span>
        )}
      </div>
    </div>
  );
}
