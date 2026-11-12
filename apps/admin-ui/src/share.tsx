// The share sheet: everything about who can open one artifact, in one place.
// Rendered on its own at /admin/share (opened from the Share button on the
// artifact itself) and at the top of the dashboard's artifact sheet.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ApiError,
  api,
  type CreatedShareLink,
  type ShareLink,
  type ShareLinkKind,
  type ShareState,
} from "./api";
import { CopyButton, Skeleton, ago, dateLabel, formatNumber } from "./ui";

// The four gate levels, said the way a person choosing one would say them.
export const ACCESS_LEVELS: Array<{
  value: string;
  label: string;
  hint: string;
}> = [
  {
    value: "public",
    label: "Anyone with the link",
    hint: "No sign-in. The address is unlisted, not secret.",
  },
  {
    value: "email",
    label: "Anyone who leaves an email",
    hint: "They type an address to get in. It is not checked.",
  },
  {
    value: "verified_email",
    label: "Anyone who verifies their email",
    hint: "A one-time code proves the address before the page opens.",
  },
  {
    value: "allowlist",
    label: "Only people you add",
    hint: "A verified email that is also on your list.",
  },
];

const LINK_KINDS: Array<{ value: ShareLinkKind; label: string; hint: string }> =
  [
    {
      value: "recipient",
      label: "One person",
      hint: "The link is theirs alone. Views and comments carry their name.",
    },
    {
      value: "password",
      label: "Passcode",
      hint: "Opens after a passcode you send separately. No email asked.",
    },
    {
      value: "open",
      label: "Open link",
      hint: "Whoever has the link gets in. Revoke it to close the door.",
    },
  ];

const shareKey = (artifactId: string) => ["artifact-share", artifactId];

// The worker's messages are written for API clients, in lower case.
const sentence = (message: string) =>
  message ? message.charAt(0).toUpperCase() + message.slice(1) : message;

export function useShareState(artifactId: string) {
  return useQuery({
    queryKey: shareKey(artifactId),
    queryFn: () => api.shareState(artifactId),
    // "Not found" and "another workspace" will not change on a retry.
    retry: (count, error) => !(error instanceof ApiError) && count < 1,
  });
}

function LinkRow({
  link,
  revoking,
  onRevoke,
}: {
  link: ShareLink;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const kind = LINK_KINDS.find((k) => k.value === link.kind);
  const name =
    link.label ||
    link.recipient_label ||
    link.recipient_email ||
    `${kind?.label || "Link"} · ${link.id.slice(-6)}`;
  const opened = link.open_count > 0;
  const opens = link.max_opens
    ? `${formatNumber(link.open_count)}/${formatNumber(link.max_opens)} opens`
    : opened
      ? `${formatNumber(link.open_count)} ${link.open_count === 1 ? "open" : "opens"}`
      : null;
  const detail = [
    kind?.label.toLowerCase() || link.kind,
    link.recipient_email && (link.label || link.recipient_label)
      ? link.recipient_email
      : null,
    opens,
    link.last_opened_at && opened
      ? `last opened ${ago(link.last_opened_at)}`
      : opened
        ? null
        : "never opened",
    link.expires_at && link.state === "active"
      ? `expires ${dateLabel(link.expires_at)}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <span>
        <strong>
          {name}{" "}
          {link.state === "active" ? null : (
            <span
              className={`pill${link.state === "revoked" ? " danger" : ""}`}
            >
              {link.state}
            </span>
          )}
        </strong>
        <small>{detail}</small>
      </span>
      {link.state === "active" ? (
        <span className="link-actions">
          <CopyButton
            text={link.url}
            label="Copy"
            className="button small ghost"
          />
          <button
            type="button"
            className="button small ghost danger"
            disabled={revoking}
            onClick={onRevoke}
          >
            Revoke
          </button>
        </span>
      ) : null}
    </li>
  );
}

const EMPTY_LINK_FORM = {
  kind: "recipient" as ShareLinkKind,
  label: "",
  recipient_email: "",
  recipient_label: "",
  passcode: "",
  expires_days: "",
  max_opens: "",
};

function LinkCreateForm({
  artifactKey,
  onCreated,
}: {
  artifactKey: string;
  onCreated: () => void;
}) {
  const [form, setForm] = useState(EMPTY_LINK_FORM);
  const [limits, setLimits] = useState(false);
  const [created, setCreated] = useState<
    (CreatedShareLink & { copied: boolean }) | null
  >(null);
  const mutation = useMutation({
    mutationFn: () =>
      api.createShareLink({ artifact_key: artifactKey, ...form }),
    onSuccess: async (link) => {
      // The click that created the link is recent enough for most browsers
      // to allow the copy; when one refuses, the Copy button is right there.
      const copied = await navigator.clipboard
        .writeText(link.url)
        .then(() => true)
        .catch(() => false);
      setCreated({ ...link, copied });
      setForm({ ...EMPTY_LINK_FORM, kind: form.kind });
      onCreated();
    },
  });
  const kind = LINK_KINDS.find((k) => k.value === form.kind);
  const set = (patch: Partial<typeof EMPTY_LINK_FORM>) =>
    setForm({ ...form, ...patch });
  return (
    <>
      {created ? (
        <div className="link-created" role="status">
          <strong>
            {created.copied ? "Link copied" : "Link created"}
            {created.recipient_email ? ` for ${created.recipient_email}` : ""}
          </strong>
          <div className="copywrap">
            <CopyButton text={created.url} />
            <input readOnly value={created.url} aria-label="New link" />
          </div>
          {created.passcode ? (
            <>
              <div className="copywrap">
                <CopyButton text={created.passcode} />
                <input
                  readOnly
                  value={created.passcode}
                  aria-label="Passcode"
                />
              </div>
              <small>
                Send the passcode separately from the link. It is shown only now
                and never stored.
              </small>
            </>
          ) : null}
          <button
            type="button"
            className="button small ghost"
            onClick={() => setCreated(null)}
          >
            Done
          </button>
        </div>
      ) : null}
      <form
        className="share-link-form"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="share-seg" role="radiogroup" aria-label="Link kind">
          {LINK_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={form.kind === k.value}
              className={form.kind === k.value ? "on" : ""}
              onClick={() => set({ kind: k.value })}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="mini share-kind-hint">{kind?.hint}</p>
        {form.kind === "recipient" ? (
          <div className="share-fields">
            <label>
              <span>Their email</span>
              <input
                type="email"
                placeholder="client@example.com"
                value={form.recipient_email}
                onChange={(e) => set({ recipient_email: e.target.value })}
              />
            </label>
            <label>
              <span>Name (optional)</span>
              <input
                placeholder="Dana from Acme"
                value={form.recipient_label}
                onChange={(e) => set({ recipient_label: e.target.value })}
              />
            </label>
          </div>
        ) : (
          <div className="share-fields">
            <label>
              <span>Label (optional)</span>
              <input
                placeholder={
                  form.kind === "password" ? "Board deck" : "Launch review"
                }
                value={form.label}
                onChange={(e) => set({ label: e.target.value })}
              />
            </label>
            {form.kind === "password" ? (
              <label>
                <span>Passcode</span>
                <input
                  placeholder="made for you when blank"
                  autoComplete="off"
                  value={form.passcode}
                  onChange={(e) => set({ passcode: e.target.value })}
                />
              </label>
            ) : null}
          </div>
        )}
        {limits ? (
          <div className="share-fields">
            <label>
              <span>Expires in days</span>
              <input
                inputMode="numeric"
                placeholder="never"
                value={form.expires_days}
                onChange={(e) => set({ expires_days: e.target.value })}
              />
            </label>
            <label>
              <span>Max opens</span>
              <input
                inputMode="numeric"
                placeholder="unlimited"
                value={form.max_opens}
                onChange={(e) => set({ max_opens: e.target.value })}
              />
            </label>
          </div>
        ) : null}
        <div className="share-form-actions">
          <button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create and copy link"}
          </button>
          {limits ? null : (
            <button
              type="button"
              className="text-button"
              onClick={() => setLimits(true)}
            >
              Add an expiry or open limit
            </button>
          )}
        </div>
        {mutation.isError ? (
          <p className="mini error" role="alert">
            {sentence(mutation.error.message)}
          </p>
        ) : null}
      </form>
    </>
  );
}

function PeopleList({
  state,
  busy,
  error,
  onAdd,
  onRemove,
}: {
  state: ShareState;
  busy: boolean;
  error: string;
  onAdd: (entries: string, done: () => void) => void;
  onRemove: (entry: string) => void;
}) {
  const [entry, setEntry] = useState("");
  const { emails, domains } = state.artifact.allowlist;
  const rows = [
    ...domains.map((domain) => ({ value: domain, domain: true })),
    ...emails.map((email) => ({ value: email, domain: false })),
  ];
  return (
    <div className="share-people">
      <form
        className="share-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (entry.trim()) onAdd(entry, () => setEntry(""));
        }}
      >
        <input
          aria-label="Add people or a domain"
          placeholder="jane@acme.com or acme.com"
          autoComplete="off"
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
        />
        <button type="submit" disabled={busy || !entry.trim()}>
          Add
        </button>
      </form>
      {error ? (
        <p className="mini error" role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {rows.length ? (
        <ul className="detail-list share-people-list">
          {rows.map((row) => (
            <li key={row.value}>
              <span>
                <strong>{row.value}</strong>
                {row.domain ? <small>Anyone with this domain</small> : null}
              </span>
              <span className="link-actions">
                <button
                  type="button"
                  className="button small ghost"
                  disabled={busy}
                  aria-label={`Remove ${row.value}`}
                  onClick={() => onRemove(row.value)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty small-empty">
          Nobody outside your workspace can open this yet. Add a person or a
          whole domain, or hand out a direct link below.
        </div>
      )}
    </div>
  );
}

export function SharePanel({
  artifactId,
  onChanged,
}: {
  artifactId: string;
  // The dashboard's artifact table shows the gate level and link count too.
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isPending, error } = useShareState(artifactId);
  const [showInactive, setShowInactive] = useState(false);
  const store = (next: ShareState) => {
    queryClient.setQueryData(shareKey(artifactId), next);
    onChanged?.();
  };
  const access = useMutation({
    mutationFn: (change: {
      gate_level?: string;
      add?: string;
      remove?: string[];
    }) => api.updateAccess({ artifact_key: data!.artifact.url_key, ...change }),
    onSuccess: store,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShareLink(data!.artifact.url_key, id),
    onSuccess: store,
  });

  if (isPending)
    return (
      <div className="share-panel">
        <Skeleton style={{ height: 38 }} />
        <Skeleton style={{ height: 190, marginTop: 18 }} />
      </div>
    );
  if (error || !data)
    return (
      <div className="share-panel">
        <p className="mini error" role="alert">
          {error?.message || "Sharing settings could not be loaded."}
        </p>
      </div>
    );

  const { artifact, links } = data;
  // While a change is in flight the choice shows where it is headed.
  const level =
    access.variables?.gate_level && access.isPending
      ? access.variables.gate_level
      : artifact.gate_level;
  const active = links.filter((link) => link.state === "active");
  const inactive = links.filter((link) => link.state !== "active");
  const levelError =
    access.isError && access.variables?.gate_level ? access.error.message : "";
  const peopleError =
    access.isError && !access.variables?.gate_level ? access.error.message : "";

  return (
    <div className="share-panel">
      {artifact.status === "suspended" || artifact.org_suspended ? (
        <p className="mini error">
          This artifact is suspended: its link does not open for anyone until
          that is lifted.
        </p>
      ) : null}
      <div className="share-linkrow">
        <input readOnly value={artifact.url} aria-label="Artifact link" />
        <CopyButton text={artifact.url} label="Copy link" className="button" />
      </div>

      <h3 id={`share-access-${artifact.id}`}>Who can open the link</h3>
      <div
        className="share-levels"
        role="radiogroup"
        aria-labelledby={`share-access-${artifact.id}`}
      >
        {ACCESS_LEVELS.map((option) => {
          const blocked = option.value === "public" && artifact.has_upstream;
          return (
            <label
              key={option.value}
              className={`share-level${level === option.value ? " on" : ""}${blocked ? " blocked" : ""}`}
            >
              <input
                type="radio"
                name={`share-level-${artifact.id}`}
                value={option.value}
                checked={level === option.value}
                disabled={blocked || access.isPending}
                onChange={() => access.mutate({ gate_level: option.value })}
              />
              <span>
                <strong>{option.label}</strong>
                <small>
                  {blocked
                    ? "Not available while this artifact has a backend attached."
                    : option.hint}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      {levelError ? (
        <p className="mini error" role="alert">
          {sentence(levelError)}
        </p>
      ) : null}
      <p className="mini">Members of your workspace can always open it.</p>

      {artifact.gate_level === "allowlist" ? (
        <>
          <h3>People you added</h3>
          <PeopleList
            state={data}
            busy={access.isPending}
            error={peopleError}
            onAdd={(entries, done) =>
              access.mutate({ add: entries }, { onSuccess: done })
            }
            onRemove={(entry) => access.mutate({ remove: [entry] })}
          />
        </>
      ) : null}

      <h3>Direct links</h3>
      <p className="mini share-lead">
        A direct link lets its holder in without the sign-in above, until it
        expires, runs out of opens, or you revoke it.
      </p>
      {active.length ? (
        <ul className="detail-list links-list">
          {active.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              revoking={revoke.isPending}
              onRevoke={() => revoke.mutate(link.id)}
            />
          ))}
        </ul>
      ) : null}
      {revoke.isError ? (
        <p className="mini error" role="alert">
          {sentence(revoke.error.message)}
        </p>
      ) : null}
      <LinkCreateForm
        artifactKey={artifact.url_key}
        onCreated={() => {
          void queryClient.invalidateQueries({
            queryKey: shareKey(artifactId),
          });
          onChanged?.();
        }}
      />
      {inactive.length ? (
        <>
          <button
            type="button"
            className="text-button"
            aria-expanded={showInactive}
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? "Hide" : "Show"} {inactive.length} past{" "}
            {inactive.length === 1 ? "link" : "links"}
          </button>
          {showInactive ? (
            <ul className="detail-list links-list">
              {inactive.slice(0, 30).map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  revoking={false}
                  onRevoke={() => {}}
                />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
