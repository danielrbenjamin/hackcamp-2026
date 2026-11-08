import CoreLocation
import ExpoModulesCore
import Foundation
import GooglePlaces

final class PlacesSearch {
  private var configured = false

  func search(_ query: String, near coordinate: CLLocationCoordinate2D? = nil, promise: Promise) {
    if !configured {
      guard let key = Bundle.main.object(forInfoDictionaryKey: "GMSApiKey") as? String,
            GMSPlacesClient.provideAPIKey(key) else {
        promise.reject("PLACES_KEY", "Google Places needs an iOS API key.")
        return
      }
      configured = true
    }
    let request = GMSAutocompleteRequest(query: query)
    if let coordinate, CLLocationCoordinate2DIsValid(coordinate) {
      let filter = GMSAutocompleteFilter()
      filter.locationBias = GMSPlaceCircularLocationOption(coordinate, 5_000)
      request.filter = filter
    }
    GMSPlacesClient.shared().fetchAutocompleteSuggestions(from: request) { results, error in
      if let error {
        promise.reject(error)
        return
      }
      let suggestions = (results ?? []).compactMap(\.placeSuggestion).map {
        ["placeId": $0.placeID, "label": $0.attributedFullText.string, "name": $0.attributedPrimaryText.string]
      }
      promise.resolve(suggestions)
    }
  }
}
