// Module managing branding and file-output configuration

export interface AppConfig {
  appName: string;
  tabTitleTemplate: string;
  defaultFilename: string;
}

// Default values
export const DEFAULT_CONFIG: AppConfig = {
  appName: 'StencilDesigner3',
  tabTitleTemplate: '{docName} - {appName}',
  defaultFilename: 'stencil',
};

// The active configuration object referenced across the application
export let config: AppConfig = { ...DEFAULT_CONFIG };

/**
 * Sanitizes an application name into a filename-safe string.
 */
function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
    .replace(/(^-|-$)/g, '');    // Strip leading and trailing hyphens
}

/**
 * Loads config.json and derives/fills in any unspecified fields.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const baseUrl = (typeof import.meta.env !== 'undefined' && import.meta.env.BASE_URL) || '/';
    const response = await fetch(`${baseUrl}config.json`);
    if (response.ok) {
      const data = await response.json();
      
      // Build the configuration object from the loaded data
      const appName = data.appName || DEFAULT_CONFIG.appName;
      
      // Derive the tab-title template (defaults to "{docName} - {appName}")
      const tabTitleTemplate = data.tabTitleTemplate || `{docName} - ${appName}`;
      
      // Derive the default filename (defaults to the sanitized application name)
      let defaultFilename = data.defaultFilename;
      if (!defaultFilename) {
        if (data.appName && data.appName !== DEFAULT_CONFIG.appName) {
          defaultFilename = sanitizeFilename(data.appName);
        } else {
          defaultFilename = DEFAULT_CONFIG.defaultFilename;
        }
      }

      config = {
        appName,
        tabTitleTemplate,
        defaultFilename,
      };
    }
  } catch (e) {
    console.warn('Failed to load config.json. Using default configuration.', e);
  }
  return config;
}
