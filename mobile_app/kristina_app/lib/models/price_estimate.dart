class PriceEstimate {
  final List<int> priceRange;
  final String timeline;
  final List<String> includes;
  final String formattedQuote;

  PriceEstimate({
    required this.priceRange,
    required this.timeline,
    required this.includes,
    required this.formattedQuote,
  });

  factory PriceEstimate.fromJson(Map<String, dynamic> json) {
    return PriceEstimate(
      priceRange: List<int>.from(json['price_range']),
      timeline: json['timeline'] ?? '',
      includes: List<String>.from(json['includes']),
      formattedQuote: json['formatted_quote'] ?? '',
    );
  }

  String get priceDisplay => '${priceRange[0]} - ${priceRange[1]} SEK';
}
