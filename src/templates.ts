import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Template cache to avoid reading files repeatedly
const templateCache = new Map<string, string>();

/**
 * Load and cache an HTML template
 */
function loadTemplate(templateName: string): string {
  if (templateCache.has(templateName)) {
    return templateCache.get(templateName)!;
  }
  
  const templatePath = join(__dirname, 'templates', `${templateName}.html`);
  const template = readFileSync(templatePath, 'utf-8');
  templateCache.set(templateName, template);
  return template;
}

/**
 * Replace placeholders in template with actual values
 */
function replacePlaceholders(template: string, variables: Record<string, string>): string {
  let result = template;
  
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder, 'g'), value);
  }
  
  return result;
}

/**
 * Render homepage with OAuth URL
 */
export function renderHomepage(authUrl: string, serverUrl: string): string {
  const template = loadTemplate('homepage');
  return replacePlaceholders(template, {
    AUTH_URL: authUrl,
    SERVER_URL: serverUrl
  });
}

/**
 * Render success page with access token
 */
export function renderSuccess(accessToken: string, serverUrl: string): string {
  const template = loadTemplate('success');
  return replacePlaceholders(template, {
    ACCESS_TOKEN: accessToken,
    SERVER_URL: serverUrl
  });
}

/**
 * Render error page with error details
 */
export function renderError(errorMessage: string, errorDetails: string): string {
  const template = loadTemplate('error');
  return replacePlaceholders(template, {
    ERROR_MESSAGE: errorMessage,
    ERROR_DETAILS: errorDetails
  });
}

/**
 * Render configuration error page
 */
export function renderConfigError(): string {
  return renderError(
    'Configuration Error',
    'SLACK_CLIENT_ID environment variable is not set. Please configure your Slack app credentials.'
  );
} 