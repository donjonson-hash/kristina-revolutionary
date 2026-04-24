class User {
  final String id;
  final String username;
  final String? email;
  final String token;
  final int expiresIn;
  final DateTime createdAt;

  User({
    required this.id,
    required this.username,
    this.email,
    required this.token,
    required this.expiresIn,
    required this.createdAt,
  });

  factory User.fromJson(Map<String, dynamic> json, String token, int expiresIn) {
    return User(
      id: json['id'] ?? '',
      username: json['username'] ?? '',
      email: json['email'],
      token: token,
      expiresIn: expiresIn,
      createdAt: DateTime.now(),
    );
  }

  bool get isTokenExpired {
    final expiry = createdAt.add(Duration(seconds: expiresIn));
    return DateTime.now().isAfter(expiry);
  }
}
