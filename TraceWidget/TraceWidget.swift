//
//  TraceWidget.swift
//  TraceWidget
//
//  WidgetKit data model + timeline provider.
//  Reads the currently-reading story from the shared App Group UserDefaults
//  (key: "currentlyReading") written by TraceWebViewController.
//

import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

struct ReadingEntry: TimelineEntry {
    let date: Date
    let title: String
    let author: String
    let fandom: String
    let progressCurrent: Int
    let progressTotal: Int?
    let status: String
    let isEmpty: Bool

    static let placeholder = ReadingEntry(
        date: Date(),
        title: "The Story Title",
        author: "Author Name",
        fandom: "Harry Potter",
        progressCurrent: 12,
        progressTotal: 45,
        status: "READING",
        isEmpty: false
    )

    static let empty = ReadingEntry(
        date: Date(),
        title: "",
        author: "",
        fandom: "",
        progressCurrent: 0,
        progressTotal: nil,
        status: "",
        isEmpty: true
    )
}

// MARK: - Timeline Provider

struct TraceWidgetProvider: TimelineProvider {
    private static let suiteName = "group.com.tracefiction.trace"
    private static let defaultsKey = "currentlyReading"

    func placeholder(in context: Context) -> ReadingEntry {
        .placeholder
    }

    func getSnapshot(in context: Context, completion: @escaping (ReadingEntry) -> Void) {
        completion(loadCurrentlyReading() ?? .placeholder)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ReadingEntry>) -> Void) {
        let entry = loadCurrentlyReading() ?? .empty
        let refreshDate = Date().addingTimeInterval(15 * 60)
        completion(Timeline(entries: [entry], policy: .after(refreshDate)))
    }

    private func loadCurrentlyReading() -> ReadingEntry? {
        guard let defaults = UserDefaults(suiteName: Self.suiteName),
              let data = defaults.data(forKey: Self.defaultsKey),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        let title = (json["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let status = (json["status"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let isEmpty = title.isEmpty && status.isEmpty

        return ReadingEntry(
            date: Date(),
            title: json["title"] as? String ?? "",
            author: json["author"] as? String ?? "",
            fandom: json["fandom"] as? String ?? "",
            progressCurrent: json["progressCurrent"] as? Int ?? 0,
            progressTotal: json["progressTotal"] as? Int,
            status: json["status"] as? String ?? "",
            isEmpty: isEmpty
        )
    }
}
