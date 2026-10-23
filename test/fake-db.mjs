// test/fake-db.mjs — shared in-memory fake pg db for the accounts /
// profile tests. Implements just the query shapes lib/accounts.js,
// lib/profile.js, and lib/usage.js (getEntitlement) issue against the
// tenants / profiles / entitlements tables. Not a test file (no
// .test.mjs suffix), so the suite glob never runs it directly.

export class FakeDb {
  constructor() {
    this.tenants = [];
    this.profiles = new Map();
    this.entitlements = new Map();
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO tenants/i.test(s)) {
      const [id, email, passwordHash, provider] = params;
      if (this.tenants.some((t) => t.email && email && t.email.toLowerCase() === email.toLowerCase())) {
        const e = new Error('duplicate key value violates unique constraint "idx_tenants_email_unique"');
        e.code = '23505';
        throw e;
      }
      this.tenants.push({ id, email, password_hash: passwordHash, auth_provider: provider, status: 'active' });
      return { rows: [] };
    }
    if (/^SELECT .* FROM tenants WHERE email/i.test(s)) {
      const row = this.tenants.find((t) => t.email === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^INSERT INTO profiles/i.test(s)) {
      const m = s.match(/INSERT INTO profiles \(([^)]+)\)/i);
      const cols = m[1].split(',').map((x) => x.trim());
      const row = this.profiles.get(params[0]) || {
        tenant_id: params[0], display_name: null, age_band: null, about_me: null,
        safety_mode: false, parent_pin_hash: null, created_at: new Date(), updated_at: new Date(),
      };
      cols.forEach((c, i) => { if (c !== 'tenant_id') row[c] = params[i]; });
      this.profiles.set(params[0], row);
      return { rows: [{ ...row }] };
    }
    if (/^SELECT .* FROM profiles WHERE tenant_id/i.test(s)) {
      const row = this.profiles.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^INSERT INTO entitlements/i.test(s)) {
      if (!this.entitlements.has(params[0])) {
        this.entitlements.set(params[0], {
          tenant_id: params[0], plan: 'free', status: 'active',
          current_period_end: null, revenuecat_app_user_id: null,
        });
      }
      return { rows: [] };
    }
    if (/^SELECT .* FROM entitlements WHERE tenant_id/i.test(s)) {
      const row = this.entitlements.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    throw new Error(`FakeDb: unhandled SQL: ${s.slice(0, 140)}`);
  }
}
