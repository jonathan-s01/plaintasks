'use strict';

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

class JiraError extends Error {}

function normalizeBaseUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    throw new JiraError('Jira URL is not a valid URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new JiraError('Jira URL must start with https://');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Minimal Jira REST client (API v2, which both Jira Cloud and Data Center/Server support).
 * type 'cloud': email + API token (Basic). type 'datacenter': personal access token (Bearer).
 */
class JiraClient {
  constructor({ baseUrl, type, email, token, fetch = globalThis.fetch }) {
    if (!token) throw new JiraError('No Jira token is configured');
    if (type !== 'cloud' && type !== 'datacenter') throw new JiraError('Jira type must be "cloud" or "datacenter"');
    if (type === 'cloud' && !email) throw new JiraError('Jira Cloud needs the account email');
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.type = type;
    this.fetch = fetch;
    this.auth = type === 'cloud' ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }

  async request(method, apiPath, body) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/rest/api/2${apiPath}`, {
        method,
        headers: { Authorization: this.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch (err) {
      throw new JiraError(`Could not reach Jira: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new JiraError('Jira rejected the credentials');
    if (res.status === 404) throw new JiraError('Jira issue or project not found');
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join('; ');
      } catch {
        /* no body */
      }
      throw new JiraError(`Jira returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  }

  issueUrl(key) {
    return `${this.baseUrl}/browse/${key}`;
  }

  async getIssue(key) {
    if (!KEY_RE.test(key)) throw new JiraError('Jira keys look like ABC-123');
    const j = await this.request('GET', `/issue/${encodeURIComponent(key)}?fields=summary,status`);
    return { key: j.key, summary: j.fields.summary, status: j.fields.status && j.fields.status.name, url: this.issueUrl(j.key) };
  }

  async createIssue({ project, issueType = 'Task', summary, description = '' }) {
    if (!project || !/^[A-Za-z][A-Za-z0-9_]*$/.test(project)) throw new JiraError('Jira project key is required');
    if (!summary) throw new JiraError('Issue summary is required');
    const j = await this.request('POST', '/issue', { fields: { project: { key: project }, issuetype: { name: issueType }, summary: summary.slice(0, 250), description } });
    return { key: j.key, url: this.issueUrl(j.key) };
  }
}

module.exports = { JiraClient, JiraError, normalizeBaseUrl, KEY_RE };
