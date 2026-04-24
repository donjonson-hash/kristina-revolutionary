import 'package:flutter/material.dart';
import '../services/api_service.dart';
import '../models/price_estimate.dart';

class PricingScreen extends StatefulWidget {
  const PricingScreen({super.key});

  @override
  State<PricingScreen> createState() => _PricingScreenState();
}

class _PricingScreenState extends State<PricingScreen> {
  final ApiService _apiService = ApiService();
  
  String _selectedType = 'landing_page';
  String _selectedComplexity = 'medium';
  String _selectedRegion = 'sweden';
  
  PriceEstimate? _estimate;
  bool _isLoading = false;
  String? _error;

  final Map<String, String> _projectTypes = {
    'landing_page': 'Лендинг',
    'mvp': 'MVP приложение',
    'redesign': 'Редизайн',
    'mobile_app': 'Мобильное приложение',
    'web_app': 'Веб-приложение',
  };

  final Map<String, String> _complexityLevels = {
    'low': 'Простой',
    'medium': 'Средний',
    'high': 'Сложный',
  };

  final Map<String, String> _regions = {
    'sweden': 'Швеция',
    'europe': 'Европа',
    'cis': 'СНГ',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Оценка проекта'),
        backgroundColor: Colors.purple,
        foregroundColor: Colors.white,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Card(
              color: Colors.purple.shade50,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    const Icon(Icons.calculate, size: 48, color: Colors.purple),
                    const SizedBox(height: 8),
                    const Text(
                      'Калькулятор стоимости',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF4A148C),
                      ),
                    ),
                    Text(
                      'Получите предварительную оценку от Кристины',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Colors.grey[600]),
                    ),
                  ],
                ),
              ),
            ),
            
            const SizedBox(height: 24),

            // Project Type
            const Text(
              'Тип проекта',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _projectTypes.entries.map((entry) {
                final isSelected = _selectedType == entry.key;
                return ChoiceChip(
                  label: Text(entry.value),
                  selected: isSelected,
                  selectedColor: Colors.purple,
                  labelStyle: TextStyle(
                    color: isSelected ? Colors.white : Colors.black,
                  ),
                  onSelected: (_) {
                    setState(() => _selectedType = entry.key);
                  },
                );
              }).toList(),
            ),

            const SizedBox(height: 24),

            // Complexity
            const Text(
              'Сложность',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: _complexityLevels.entries.map((entry) {
                return ButtonSegment(
                  value: entry.key,
                  label: Text(entry.value),
                );
              }).toList(),
              selected: {_selectedComplexity},
              onSelectionChanged: (set) {
                setState(() => _selectedComplexity = set.first);
              },
            ),

            const SizedBox(height: 24),

            // Region
            const Text(
              'Регион',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _selectedRegion,
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.location_on),
              ),
              items: _regions.entries.map((entry) {
                return DropdownMenuItem(
                  value: entry.key,
                  child: Text(entry.value),
                );
              }).toList(),
              onChanged: (value) {
                setState(() => _selectedRegion = value!);
              },
            ),

            const SizedBox(height: 32),

            // Calculate Button
            SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                onPressed: _isLoading ? null : _calculatePrice,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.purple,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
                child: _isLoading
                    ? const CircularProgressIndicator(color: Colors.white)
                    : const Text(
                        'Рассчитать стоимость',
                        style: TextStyle(fontSize: 16),
                      ),
              ),
            ),

            // Error
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Colors.red),
                ),
              ),

            // Result
            if (_estimate != null) ...[
              const SizedBox(height: 32),
              _buildResultCard(),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildResultCard() {
    return Card(
      elevation: 4,
      color: Colors.green[50],
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                Icon(Icons.check_circle, color: Colors.green, size: 32),
                const SizedBox(width: 12),
                const Expanded(
                  child: Text(
                    'Оценка готова!',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF1B5E20),
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 24),
            
            // Price
            Text(
              'Стоимость',
              style: TextStyle(color: Colors.grey[600]),
            ),
            Text(
              '${_estimate!.priceRange[0]} - ${_estimate!.priceRange[1]} SEK',
              style: const TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.bold,
                color: Colors.purple,
              ),
            ),
            
            const SizedBox(height: 16),
            
            // Timeline
            Text(
              'Сроки',
              style: TextStyle(color: Colors.grey[600]),
            ),
            Text(
              _estimate!.timeline,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 16),
            
            // Includes
            Text(
              'Что входит:',
              style: TextStyle(color: Colors.grey[600]),
            ),
            const SizedBox(height: 8),
            ..._estimate!.includes.map((item) => Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.check, size: 16, color: Colors.green),
                  const SizedBox(width: 8),
                  Expanded(child: Text(item)),
                ],
              ),
            )),
            
            const SizedBox(height: 16),
            
            // Formatted quote
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                _estimate!.formattedQuote,
                style: TextStyle(fontSize: 12, color: Colors.grey[700]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _calculatePrice() async {
    setState(() {
      _isLoading = true;
      _error = null;
      _estimate = null;
    });

    try {
      final estimate = await _apiService.getPriceEstimate(
        _selectedType,
        complexity: _selectedComplexity,
        region: _selectedRegion,
      );
      
      setState(() {
        _estimate = estimate;
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _error = 'Ошибка: $e';
        _isLoading = false;
      });
    }
  }
}
