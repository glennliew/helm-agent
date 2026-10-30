# Tides

Small helpers for planning a coastal sailing passage: unit conversions and passage-time estimates that account for the tidal current.

```python
from tides.passage import describe
describe(15, 6, 1.5)   # '15 nm (27.8 km) in about 2 h 00 min'
```

Run the tests with:

```sh
python3 -m unittest -v
```

The tide API key for the (future) live tide lookup lives in `.env`.
