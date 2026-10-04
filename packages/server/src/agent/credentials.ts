/** The selected auth mode takes precedence over inherited credentials. */
export function credentialEnvironment(apiKey: string | null): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: apiKey ?? '',
    ANTHROPIC_AUTH_TOKEN: '',
    ...(apiKey === null ? {} : { CLAUDE_CODE_OAUTH_TOKEN: '' }),
  };
}
