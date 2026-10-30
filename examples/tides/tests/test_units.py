import unittest

from tides.units import knots_to_kmh, nm_to_km


class UnitsTest(unittest.TestCase):
    def test_one_nautical_mile_is_1852_metres(self):
        self.assertAlmostEqual(nm_to_km(1), 1.852, places=3)

    def test_ten_knots_in_kmh(self):
        self.assertAlmostEqual(knots_to_kmh(10), 18.52, places=2)

    def test_zero(self):
        self.assertEqual(nm_to_km(0), 0)


if __name__ == "__main__":
    unittest.main()
