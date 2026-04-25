//
//  TraceWidgetViews.swift
//  TraceWidget
//
//  Minimal system-adjacent widget: flat panel, one progress control, SF typography.
//

import SwiftUI
import WidgetKit

// MARK: - Deep link

private enum TraceDeepLink {
    private static let widgetAppGroup = "group.com.tracefiction.trace"
    private static let widgetWebOriginKey = "widgetWebOrigin"

    static func libraryURL() -> URL {
        let fallback = URL(string: "https://tracefiction.com/?trace_app=1")!
        guard let defaults = UserDefaults(suiteName: widgetAppGroup) else { return fallback }
        let raw = (defaults.string(forKey: widgetWebOriginKey) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, let base = URL(string: raw),
              var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return fallback }
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "trace_app", value: "1")]
        return parts.url ?? fallback
    }
}

// MARK: - Background (nearly flat — avoids loud light→dark bands)

private struct WidgetPanelBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if colorScheme == .dark {
            LinearGradient(
                colors: [
                    Color(red: 0.118, green: 0.118, blue: 0.125),
                    Color(red: 0.098, green: 0.098, blue: 0.104),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        } else {
            LinearGradient(
                colors: [
                    Color(red: 0.965, green: 0.965, blue: 0.97),
                    Color(red: 0.945, green: 0.945, blue: 0.952),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }
}

// MARK: - Text colors

private enum WidgetLabel {
    static func primary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? .white : Color(red: 0.05, green: 0.05, blue: 0.07)
    }

    static func secondary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.5) : Color.black.opacity(0.45)
    }

    static func tertiary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color.white.opacity(0.32) : Color.black.opacity(0.35)
    }
}

private func statusLine(_ raw: String) -> String {
    switch raw.uppercased() {
    case "READING": return "Reading"
    case "PLANNING": return "Planning"
    case "PAUSED": return "Paused"
    case "COMPLETED": return "Completed"
    case "DROPPED": return "Dropped"
    default: return raw.isEmpty ? "" : raw.capitalized
    }
}

/// App mark (from asset catalog) + optional wordmark. On small widgets use `expanded: false` (icon only).
private struct WidgetBrandRow: View {
    @Environment(\.colorScheme) private var colorScheme
    let status: String
    var expanded: Bool

    var body: some View {
        HStack(alignment: .center) {
            if !status.isEmpty {
                Text(statusLine(status))
                    .font(expanded ? .caption.weight(.medium) : .caption2.weight(.medium))
                    .foregroundStyle(WidgetLabel.secondary(colorScheme))
            }
            Spacer(minLength: 6)
            HStack(spacing: expanded ? 6 : 0) {
                Image("TraceMark")
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(1, contentMode: .fit)
                    .frame(width: expanded ? 18 : 16, height: expanded ? 18 : 16)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .accessibilityLabel("trace")
                if expanded {
                    Text("trace")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(WidgetLabel.tertiary(colorScheme))
                }
            }
        }
    }
}

// MARK: - Entry

struct TraceWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var colorScheme

    var entry: ReadingEntry

    var body: some View {
        Group {
            if entry.isEmpty {
                emptyContent
            } else {
                switch family {
                case .systemMedium:
                    mediumContent
                default:
                    smallContent
                }
            }
        }
        .widgetURL(TraceDeepLink.libraryURL())
    }

    private var emptyContent: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 8) {
                Text("Nothing reading")
                    .font(.headline)
                    .foregroundStyle(WidgetLabel.primary(colorScheme))
                Text("Open Trace to pick up a story.")
                    .font(.caption)
                    .foregroundStyle(WidgetLabel.secondary(colorScheme))
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
            WidgetBrandRow(status: "", expanded: true)
                .padding(.top, 10)
                .padding(.trailing, 12)
        }
        .containerBackground(for: .widget) {
            WidgetPanelBackground()
        }
    }

    private var mediumContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetBrandRow(status: entry.status, expanded: true)

            Text(entry.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(WidgetLabel.primary(colorScheme))
                .lineLimit(2)
                .minimumScaleFactor(0.88)
                .padding(.top, 10)

            metaText
                .padding(.top, 4)

            if let t = entry.progressTotal, t > 0 {
                ProgressView(
                    value: Double(entry.progressCurrent),
                    total: Double(t)
                )
                .progressViewStyle(.linear)
                .tint(Color(red: 0.2, green: 0.78, blue: 0.55))
                .padding(.top, 14)

                Text("Chapter \(entry.progressCurrent) of \(t)")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(WidgetLabel.tertiary(colorScheme))
                    .padding(.top, 6)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) {
            WidgetPanelBackground()
        }
    }

    private var smallContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            WidgetBrandRow(status: entry.status, expanded: false)

            Text(entry.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(WidgetLabel.primary(colorScheme))
                .lineLimit(4)
                .minimumScaleFactor(0.85)
                .padding(.top, 8)

            if let t = entry.progressTotal, t > 0 {
                ProgressView(
                    value: Double(entry.progressCurrent),
                    total: Double(t)
                )
                .progressViewStyle(.linear)
                .tint(Color(red: 0.2, green: 0.78, blue: 0.55))
                .padding(.top, 12)

                Text("Ch \(entry.progressCurrent) / \(t)")
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(WidgetLabel.tertiary(colorScheme))
                    .padding(.top, 5)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) {
            WidgetPanelBackground()
        }
    }

    @ViewBuilder
    private var metaText: some View {
        let parts = metaParts
        if parts.isEmpty {
            EmptyView()
        } else {
            Text(parts.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(WidgetLabel.secondary(colorScheme))
                .lineLimit(2)
        }
    }

    private var metaParts: [String] {
        var s: [String] = []
        if !entry.author.isEmpty { s.append(entry.author) }
        if !entry.fandom.isEmpty { s.append(entry.fandom) }
        return s
    }
}
