/**
 * The end-to-end harness.
 *
 * These suites talk to a running API over HTTP rather than importing it, so
 * they exercise what a browser would: the tRPC envelope, the session cookie,
 * the permission checks and the worker. That is deliberate — most of the bugs
 * these found were in the seams between those, not inside a function.
 */

export const BASE = process.env.ECM_API ?? 'http://127.0.0.1:4000';

/** One signed-in caller. Each suite makes as many as it needs users. */
export function client() {
  let cookie = '';

  async function call(path, input, method) {
    const url =
      method === 'GET'
        ? `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
        : `${BASE}/trpc/${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      if (c.startsWith('ecm_session=')) cookie = c.split(';')[0];
    }
    const body = await res.json();
    if (body.error) {
      const err = new Error(body.error.message);
      err.code = body.error.data?.code;
      throw err;
    }
    return body.result?.data;
  }

  return {
    q: (p, i) => call(p, i, 'GET'),
    m: (p, i) => call(p, i, 'POST'),
    /** For the plain HTTP routes: upload segments and file downloads. */
    raw: (path, init) =>
      fetch(`${BASE}${path}`, { ...init, headers: { ...init?.headers, Cookie: cookie } }),
  };
}

let failures = 0;

export function assert(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A call that must be refused, with the missing right named in the message. */
export async function refused(label, fn, expectRight) {
  try {
    await fn();
    failures += 1;
    console.log(`FAIL  ${label} — the call succeeded`);
  } catch (err) {
    const named = expectRight ? err.message.includes(expectRight) : true;
    assert(label, err.code === 'FORBIDDEN' && named, `${err.code}: ${err.message}`);
  }
}

/** A call that must fail, with `expect` somewhere in the message. */
export async function rejected(label, fn, expect) {
  try {
    await fn();
    failures += 1;
    console.log(`FAIL  ${label} — accepted`);
  } catch (err) {
    assert(label, expect ? err.message.includes(expect) : true, err.message);
  }
}

/**
 * A call that must behave as though the document were not there. `NOT_FOUND`
 * and not `FORBIDDEN`: "you may not see this" confirms it exists.
 */
export async function hidden(label, fn) {
  try {
    const result = await fn();
    failures += 1;
    console.log(`FAIL  ${label} — returned ${JSON.stringify(result).slice(0, 90)}`);
  } catch (err) {
    assert(label, err.code === 'NOT_FOUND', `${err.code}: ${err.message}`);
  }
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sign in as the seeded administrator. */
export async function asAdmin() {
  const admin = client();
  await admin.m('session.login', {
    userName: 'admin',
    password: process.env.ECM_ADMIN_PASSWORD,
  });
  return admin;
}

export function finish() {
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
