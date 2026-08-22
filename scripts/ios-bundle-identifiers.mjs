export const IOS_PRODUCTION_APP_BUNDLE_IDENTIFIER = "com.tracefiction.trace";
export const IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER =
  "com.tracefiction.trace.extension";
export const IOS_PRODUCTION_WIDGET_BUNDLE_IDENTIFIER =
  "com.tracefiction.trace.TraceWidget";

export function embeddedBundleIdentifierError(
  appBundleIdentifier,
  embeddedBundleIdentifier,
) {
  if (!appBundleIdentifier || !embeddedBundleIdentifier) {
    return "App and embedded bundle identifiers must both be present";
  }

  const requiredPrefix = `${appBundleIdentifier}.`;
  if (!embeddedBundleIdentifier.startsWith(requiredPrefix)) {
    return `Embedded bundle identifier ${embeddedBundleIdentifier} must start with ${requiredPrefix}`;
  }

  const embeddedComponent = embeddedBundleIdentifier.slice(requiredPrefix.length);
  if (!embeddedComponent || embeddedComponent.includes(".")) {
    return `Embedded bundle identifier ${embeddedBundleIdentifier} must contain exactly one component after ${appBundleIdentifier}`;
  }

  return null;
}

export function productionEmbeddedBundleIdentifierError(
  embeddedBundleIdentifier,
) {
  if (
    embeddedBundleIdentifier === IOS_PRODUCTION_EXTENSION_BUNDLE_IDENTIFIER ||
    embeddedBundleIdentifier === IOS_PRODUCTION_WIDGET_BUNDLE_IDENTIFIER
  ) {
    return null;
  }

  return `Unexpected production embedded bundle identifier ${embeddedBundleIdentifier}`;
}
