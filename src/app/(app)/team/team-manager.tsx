"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateIn } from "@/lib/timezone";

type BranchOption = { id: string; name: string };
type Member = {
  id: string;
  role: "OWNER" | "MANAGER" | "CASHIER" | "ACCOUNTANT";
  isActive: boolean;
  user: { id: string; name: string; email: string; phone: string | null };
  branch: BranchOption | null;
};
type Invitation = {
  id: string;
  email: string;
  role: "OWNER" | "MANAGER" | "CASHIER" | "ACCOUNTANT"; // widened to match Prisma's BusinessRole; the invite API never issues OWNER
  branch: BranchOption | null;
  expiresAt: string;
};

const EDITABLE_ROLES = ["MANAGER", "CASHIER", "ACCOUNTANT"] as const;

export function TeamManager({
  businessId,
  currentUserId,
  members,
  invitations,
  branches,
  timeZone,
}: {
  businessId: string;
  currentUserId: string;
  members: Member[];
  invitations: Invitation[];
  branches: BranchOption[];
  timeZone: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function patchMember(memberId: string, payload: Record<string, unknown>) {
    setError(null);
    setBusyId(memberId);
    const res = await fetch(`/api/business/${businessId}/team/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setBusyId(null);
    if (!res.ok) {
      setError(data.message ?? "Could not update this team member.");
      return;
    }
    router.refresh();
  }

  async function revokeInvitation(invitationId: string) {
    setError(null);
    setBusyId(invitationId);
    const res = await fetch(`/api/business/${businessId}/team/invitations/${invitationId}`, { method: "POST" });
    const data = await res.json();
    setBusyId(null);
    if (!res.ok) {
      setError(data.message ?? "Could not revoke this invitation.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-8">
      {error && <p className="rounded bg-erp-danger/10 p-3 text-sm text-erp-danger">{error}</p>}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-erp-muted">Members</h2>
        <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
          <thead className="bg-erp-subtle text-left">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Contact</th>
              <th className="p-3">Role</th>
              <th className="p-3">Branch</th>
              <th className="p-3">Status</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isSelf = m.user.id === currentUserId;
              const isOwner = m.role === "OWNER";
              return (
                <tr key={m.id} className="border-t">
                  <td className="p-3 font-medium">
                    {m.user.name}
                    {isSelf && <span className="ml-1 text-xs text-erp-muted">(you)</span>}
                  </td>
                  <td className="p-3 text-erp-muted">
                    {m.user.email}
                    {m.user.phone && <div className="text-xs text-erp-muted">{m.user.phone}</div>}
                  </td>
                  <td className="p-3">
                    {isOwner ? (
                      <span className="text-erp-muted">Owner</span>
                    ) : (
                      <select
                        value={m.role}
                        disabled={busyId === m.id}
                        onChange={(e) => patchMember(m.id, { role: e.target.value })}
                        className="rounded border border-erp-border px-2 py-1"
                      >
                        {EDITABLE_ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="p-3">
                    {isOwner ? (
                      <span className="text-erp-muted">{m.branch?.name ?? "All branches"}</span>
                    ) : (
                      <select
                        value={m.branch?.id ?? ""}
                        disabled={busyId === m.id}
                        onChange={(e) => patchMember(m.id, { branchId: e.target.value || null })}
                        className="rounded border border-erp-border px-2 py-1"
                      >
                        <option value="">All branches</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="p-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        m.isActive ? "bg-erp-success/10 text-erp-success" : "bg-erp-subtle text-erp-muted"
                      }`}
                    >
                      {m.isActive ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td className="p-3">
                    {!isOwner && !isSelf && (
                      <button
                        type="button"
                        disabled={busyId === m.id}
                        onClick={() => patchMember(m.id, { isActive: !m.isActive })}
                        className={`text-sm underline ${m.isActive ? "text-erp-danger" : "text-erp-primary"}`}
                      >
                        {m.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-erp-muted">Pending Invitations</h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-erp-muted">No pending invitations.</p>
        ) : (
          <div className="overflow-x-auto"><table className="w-full border-collapse overflow-hidden rounded border bg-erp-surface text-sm">
            <thead className="bg-erp-subtle text-left">
              <tr>
                <th className="p-3">Email</th>
                <th className="p-3">Role</th>
                <th className="p-3">Branch</th>
                <th className="p-3">Expires</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="p-3">{i.email}</td>
                  <td className="p-3">{i.role}</td>
                  <td className="p-3 text-erp-muted">{i.branch?.name ?? "All branches"}</td>
                  <td className="p-3 text-erp-muted">{formatDateIn(i.expiresAt, timeZone)}</td>
                  <td className="p-3">
                    <button
                      type="button"
                      disabled={busyId === i.id}
                      onClick={() => revokeInvitation(i.id)}
                      className="text-sm text-erp-danger underline"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
