/**
 * Thin fetch wrapper. Same-origin requests inherit the session cookie; we
 * normalize errors so views can treat 401 as a sentinel and bounce to sign-in.
 */

export class HttpError extends Error {
  constructor(public status: number, message: string, public payload: unknown = null) {
    super(message);
  }
}

export type TenantMe = {
  kind: "tenant";
  apexDomain: string;
  admin: {
    id: string;
    email: string;
    role: "admin" | "moderator" | "super_admin";
    displayName: string | null;
  };
  tenant: { id: string; slug: string; displayName: string };
};

export type SiteMe = {
  kind: "site";
  apexDomain: string;
  siteAdmin: {
    id: string;
    email: string;
    role: "admin" | "super_admin";
    displayName: string | null;
  };
  tenants: Array<{
    id: string;
    slug: string;
    displayName: string;
    plan: "free" | "byo_domain";
    status: "active" | "suspended";
    createdAt: number;
  }>;
};

export type Me = SiteMe | TenantMe;

export type TeamMember = {
  id: string;
  email: string;
  role: "admin" | "moderator" | "super_admin";
  createdAt: number;
};

export type PostingPolicy = "members" | "moderated" | "announce_only" | "open";
export type ReplyToPolicy = "list" | "sender";
export type ArchiveVisibility = "members" | "public" | "none";

export type GroupSummary = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  postingPolicy: PostingPolicy;
  replyToPolicy: ReplyToPolicy;
  subjectPrefix: string | null;
  archiveVisibility: ArchiveVisibility;
  maxMessageSize: number;
  subscribeStatement: string | null;
  activeMemberCount: number;
  lastMessageAt: number | null;
  createdAt: number;
};

export type PendingRequest = {
  id: string;
  email: string;
  displayName: string;
  about: string | null;
  state: "pending" | "approved" | "rejected";
  createdAt: number;
};

export type CreateGroupInput = {
  name: string;
  displayName: string;
  description?: string | null;
  postingPolicy: PostingPolicy;
  replyToPolicy?: ReplyToPolicy;
  subjectPrefix?: string | null;
  archiveVisibility?: ArchiveVisibility;
  maxMessageSize?: number;
  subscribeStatement?: string | null;
};

export type UpdateGroupInput = Partial<{
  displayName: string;
  description: string | null;
  postingPolicy: PostingPolicy;
  replyToPolicy: ReplyToPolicy;
  subjectPrefix: string | null;
  archiveVisibility: ArchiveVisibility;
  maxMessageSize: number;
  subscribeStatement: string | null;
}>;

export type Member = {
  id: string;
  email: string;
  displayName: string | null;
  role: "member" | "moderator" | "sender_only";
  deliveryMode: "each" | "digest" | "paused";
  status: "active" | "bouncing" | "unsubscribed" | "pending_confirmation";
  bounceCount: number;
  lastBounceAt: number | null;
  joinedAt: number;
};

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (payload !== undefined) init.body = payload;
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = text; }
  }
  if (!res.ok) {
    throw new HttpError(res.status, `${method} ${path} → ${res.status}`, json);
  }
  return json;
}

export const api = {
  requestMagicLink(email: string): Promise<unknown> {
    return request("POST", "/api/auth/request", { email });
  },
  signupAvailable(): Promise<{ available: boolean }> {
    return request("GET", "/api/auth/signup-available") as Promise<{ available: boolean }>;
  },
  signup(email: string): Promise<unknown> {
    return request("POST", "/api/auth/signup", { email });
  },
  signout(): Promise<unknown> {
    return request("POST", "/api/auth/signout");
  },
  me(): Promise<Me> {
    return request("GET", "/api/me") as Promise<Me>;
  },
  listGroups(): Promise<{ groups: GroupSummary[] }> {
    return request("GET", "/api/groups") as Promise<{ groups: GroupSummary[] }>;
  },
  createGroup(input: CreateGroupInput): Promise<{ id: string }> {
    return request("POST", "/api/groups", input) as Promise<{ id: string }>;
  },
  updateGroup(groupId: string, patch: UpdateGroupInput): Promise<unknown> {
    return request("PATCH", `/api/groups/${groupId}`, patch);
  },
  listMembers(groupId: string): Promise<{ members: Member[] }> {
    return request("GET", `/api/groups/${groupId}/members`) as Promise<{ members: Member[] }>;
  },
  addMember(groupId: string, input: { email: string; displayName?: string; role?: Member["role"] }): Promise<{ id: string }> {
    return request("POST", `/api/groups/${groupId}/members`, input) as Promise<{ id: string }>;
  },
  updateRole(groupId: string, memberId: string, role: Member["role"]): Promise<unknown> {
    return request("PATCH", `/api/groups/${groupId}/members/${memberId}`, { role });
  },
  removeMember(groupId: string, memberId: string): Promise<unknown> {
    return request("DELETE", `/api/groups/${groupId}/members/${memberId}`);
  },
  bulkPreview(groupId: string, csv: string): Promise<{ toAdd: string[]; duplicates: string[]; invalid: string[]; total: number }> {
    return request("POST", `/api/groups/${groupId}/members/bulk-preview`, { csv }) as Promise<{ toAdd: string[]; duplicates: string[]; invalid: string[]; total: number }>;
  },
  bulkCommit(groupId: string, emails: string[]): Promise<{ added: string[]; skipped: string[]; invalid: string[] }> {
    return request("POST", `/api/groups/${groupId}/members/bulk`, { emails }) as Promise<{ added: string[]; skipped: string[]; invalid: string[] }>;
  },
  listPending(groupId: string): Promise<{ requests: PendingRequest[] }> {
    return request("GET", `/api/groups/${groupId}/pending`) as Promise<{ requests: PendingRequest[] }>;
  },
  approvePending(groupId: string, reqId: string): Promise<{ memberId: string | null; existed: boolean }> {
    return request("POST", `/api/groups/${groupId}/pending/${reqId}/approve`) as Promise<{ memberId: string | null; existed: boolean }>;
  },
  rejectPending(groupId: string, reqId: string, note?: string): Promise<unknown> {
    return request("POST", `/api/groups/${groupId}/pending/${reqId}/reject`, { note: note ?? null });
  },
  // Site-admin endpoints
  createTenant(input: { slug: string; displayName: string; adminEmail: string }): Promise<{ tenant: { id: string; slug: string; displayName: string }; adminId: string }> {
    return request("POST", "/api/tenants", input) as Promise<{ tenant: { id: string; slug: string; displayName: string }; adminId: string }>;
  },
  // Tenant team management
  listTeam(): Promise<{ team: TeamMember[] }> {
    return request("GET", "/api/team") as Promise<{ team: TeamMember[] }>;
  },
  addTeamMember(email: string, role: "admin" | "moderator"): Promise<{ id: string; role: string }> {
    return request("POST", "/api/team", { email, role }) as Promise<{ id: string; role: string }>;
  },
  updateTeamRole(id: string, role: "admin" | "moderator"): Promise<unknown> {
    return request("PATCH", `/api/team/${id}`, { role });
  },
  removeTeamMember(id: string): Promise<unknown> {
    return request("DELETE", `/api/team/${id}`);
  },
  updateProfile(displayName: string | null): Promise<{ displayName: string | null }> {
    return request("PATCH", "/api/profile", { displayName }) as Promise<{ displayName: string | null }>;
  },
};
