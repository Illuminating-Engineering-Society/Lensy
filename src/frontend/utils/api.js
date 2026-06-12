/**
 * Lensy API Client
 * Frontend utility for communicating with the Lensy Worker API.
 */

const BASE_URL = '/api';

const LensyAPI = {

  /**
   * Search IES standards.
   * @param {string} query
   * @param {{ filters?: Object, includeAISummary?: boolean, limit?: number }} options
   */
  async search(query, options = {}) {
    const response = await fetch(`${BASE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        filters: options.filters || {},
        includeAISummary: options.includeAISummary || false,
        limit: options.limit || 10,
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || 'Search failed');
    }
    return response.json();
  },

  /**
   * Get a single application by code.
   * @param {string} code
   */
  async getApplication(code) {
    const response = await fetch(`${BASE_URL}/applications/${encodeURIComponent(code)}`);
    if (!response.ok) throw new Error('Application not found');
    return response.json();
  },

  /**
   * List all user projects.
   * @param {string|number} userId
   */
  async listProjects(userId = 1) {
    const response = await fetch(`${BASE_URL}/projects?user_id=${userId}`);
    if (!response.ok) throw new Error('Failed to load projects');
    return response.json();
  },

  /**
   * Get a project with its applications.
   * @param {string|number} projectId
   */
  async getProject(projectId) {
    const response = await fetch(`${BASE_URL}/projects/${projectId}`);
    if (!response.ok) throw new Error('Project not found');
    return response.json();
  },

  /**
   * Create a new project.
   * @param {Object} data - { name, location, client_name, ... }
   */
  async createProject(data) {
    const response = await fetch(`${BASE_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(err.error || 'Failed to create project');
    }
    return response.json();
  },

  /**
   * Add one or more applications to a project.
   * @param {string} applicationCode
   * @param {string|number|null} projectId - null to create a new project first
   * @param {Object} meta - { quantity, room_names, custom_notes }
   */
  async addToProject(applicationCode, projectId, meta = {}) {
    if (!projectId) {
      const name = prompt('New project name:') || `Project ${new Date().toLocaleDateString()}`;
      const created = await LensyAPI.createProject({ name, user_id: 1 });
      projectId = created.project.id;
    }
    const response = await fetch(`${BASE_URL}/projects/${projectId}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_code: applicationCode,
        quantity: meta.quantity || 1,
        room_names: meta.room_names || null,
        custom_notes: meta.custom_notes || null,
      }),
    });
    if (!response.ok) throw new Error('Failed to add to project');
    return response.json();
  },

  /**
   * Add multiple application codes to a project in one request.
   * @param {string[]} applicationCodes
   * @param {string|number|null} projectId
   */
  async addManyToProject(applicationCodes, projectId) {
    const codes = Array.isArray(applicationCodes)
      ? [...new Set(applicationCodes.filter(Boolean))]
      : [];

    if (codes.length === 0) {
      throw new Error('No applications selected');
    }

    if (!projectId) {
      const name = prompt('New project name:') || `Project ${new Date().toLocaleDateString()}`;
      const created = await LensyAPI.createProject({ name, user_id: 1 });
      projectId = created.project.id;
    }

    const payload = codes.map(code => ({
      application_code: code,
      quantity: 1,
      room_names: null,
      custom_notes: null,
    }));

    const response = await fetch(`${BASE_URL}/projects/${projectId}/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error('Failed to add selected applications to project');
    return response.json();
  },

  /**
   * Export project data as JSON (client renders PDF/Excel from this).
   * @param {string|number} projectId
   */
  async exportProject(projectId) {
    const response = await fetch(`${BASE_URL}/projects/${projectId}/export?format=json`);
    if (!response.ok) throw new Error('Export failed');
    return response.json();
  },
};

// Make available globally for inline event handlers
if (typeof window !== 'undefined') {
  window.LensyAPI = LensyAPI;
}
