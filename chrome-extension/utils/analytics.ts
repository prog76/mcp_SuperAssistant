export async function sendAnalyticsEvent(name: string, _params: { [key: string]: any }): Promise<void> {
  // Analytics disabled in this fork
  console.debug(`[Analytics disabled] Event: ${name}`);
}

export function collectDemographicData(): { [key: string]: any } {
  // No demographic data collected
  return {};
}

export async function trackUrlChange(_url: string): Promise<void> {
  console.debug('[Analytics disabled] trackUrlChange');
}

export async function trackPageView(): Promise<void> {
  console.debug('[Analytics disabled] trackPageView');
}

export async function trackError(error: Error, context: string): Promise<void> {
  console.debug(`[Analytics disabled] trackError in ${context}: ${error.message}`);
}
