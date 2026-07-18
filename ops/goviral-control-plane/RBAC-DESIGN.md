# GoViral Control Plane — RBAC Design

## Role Definitions

| Role       | Description                                           | Scope                    |
| ---------- | ----------------------------------------------------- | ------------------------ |
| `viewer`   | Read-only access to all control plane endpoints       | Default for anonymous    |
| `operator` | Can approve/reject items, launch tasks, manage canary | Authenticated local user |
| `admin`    | Full access including integration config, Telegram    | Tailscale/Archon user    |

## Role Resolution

1. **Tailscale header** (`Tailscale-User-Login`): resolves to `admin`
2. **Archon web auth** (`X-Archon-User`): resolves to `admin`
3. **Anonymous + GOVIRAL_ACTIONS_ENABLED=1**: resolves to `operator`
4. **Anonymous otherwise**: resolves to `viewer`

## Permission Matrix

| Action                    | viewer | operator | admin |
| ------------------------- | ------ | -------- | ----- |
| Read all endpoints        | yes    | yes      | yes   |
| Approve/reject items      | no     | yes      | yes   |
| Create/cancel agent tasks | no     | yes      | yes   |
| Launch/cancel canary      | no     | yes      | yes   |
| Acknowledge incidents     | no     | yes      | yes   |
| Save search filters       | no     | yes      | yes   |
| Execute governed actions  | no     | yes      | yes   |
| Test Telegram             | no     | no       | yes   |
| Enable integrations       | no     | no       | yes   |
| Admin configuration       | no     | no       | yes   |

## Enforcement Mode

- **active**: Role checks are enforced; unauthorized requests return 403
- **advisory**: Role checks are computed but not blocking (future use)
- **disabled**: No role checks (not recommended for production)

Current enforcement is `active` when `GOVIRAL_ACTIONS_ENABLED=1`, otherwise `advisory`.

## Security Notes

- Roles are resolved per-request from headers, not persisted
- No secrets or tokens are exposed through RBAC endpoints
- The `viewer` role can read all operational data but cannot mutate state
- Rate limiting is applied independently of role enforcement
