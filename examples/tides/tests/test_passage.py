import unittest

from tides.passage import describe, eta_hours, speed_over_ground


class PassageTest(unittest.TestCase):
    def test_fair_tide_speeds_you_up(self):
        self.assertAlmostEqual(speed_over_ground(6, 1.5), 7.5)

    def test_foul_tide_slows_you_down(self):
        self.assertAlmostEqual(speed_over_ground(6, -1.5), 4.5)

    def test_eta_with_a_fair_tide(self):
        self.assertAlmostEqual(eta_hours(15, 6, 1.5), 2.0)

    def test_no_headway_against_a_strong_foul_tide(self):
        with self.assertRaises(ValueError):
            eta_hours(10, 5, -6)

    def test_describe(self):
        self.assertEqual(describe(15, 6, 1.5), "15 nm (27.8 km) in about 2 h 00 min")


if __name__ == "__main__":
    unittest.main()
