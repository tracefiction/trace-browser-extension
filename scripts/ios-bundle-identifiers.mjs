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
