//
//  TraceWidgetBundle.swift
//  TraceWidget
//
//  Entry point for the WidgetKit extension.
//

import WidgetKit
import SwiftUI

@main
struct TraceWidgetBundle: WidgetBundle {
    var body: some Widget {
        TraceCurrentlyReadingWidget()
    }
}

struct TraceCurrentlyReadingWidget: Widget {
    let kind = "TraceCurrentlyReading"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TraceWidgetProvider()) { entry in
            TraceWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Currently Reading")
        .description("Shows your current story progress in Trace.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}
