"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import { formatDateTime, userName } from "@/lib/format";
import type { Comment } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toaster";
import { PanelSection } from "./shared";

export function CommentsPanel({ slideId, comments, onChanged }: { slideId: string; comments: Comment[] | null; onChanged: () => Promise<void> | void }) {
  const { can, demoUsers } = useSession();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div data-testid="comments-panel">
      <PanelSection title={`Comments (${comments?.length ?? 0})`}>
        {comments && comments.length === 0 ? <p className="text-small text-graphite">No comment yet. Comments are for workflow notes, never patient identifiers.</p> : null}
        <ol className="space-y-2.5">
          {(comments ?? []).map((c) => (
            <li key={c.id} className="rounded-[var(--radius-control)] border border-line bg-sheet px-3 py-2">
              <p className="text-micro text-graphite">
                <strong className="text-ink">{userName(c.author_id, demoUsers)}</strong> · {formatDateTime(c.created_at)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-small text-ink">{c.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-3 space-y-2">
          <TextArea label="Add a comment" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} data-testid="comment-input" />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              busy={busy}
              data-testid="post-comment"
              unavailable={!can("comment.write") ? "Commenting needs a project role other than admin." : !body.trim() ? "Write something first." : null}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/slides/${slideId}/comments`, { method: "POST", body: { body: body.trim() } });
                  setBody("");
                  await onChanged();
                } catch (err) {
                  toast.show({ tone: "error", title: "Comment not posted", body: errorText(err) });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Post comment
            </Button>
          </div>
        </div>
      </PanelSection>
    </div>
  );
}
