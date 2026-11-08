package main

// Carrier is a hand-curated backbone city code (CLLI-style, as in
// "chcgil09.us.bb.gin.ntt.net") with the city's approximate centre.
type Carrier struct {
	Code string
	City string
	Lat  float64
	Lon  float64
}

// carrierCodes lists common 6-character carrier city codes. They are specific
// enough to match anywhere in a hostname, unlike 3-letter IATA codes.
var carrierCodes = []Carrier{
	{"chcgil", "Chicago", 41.88, -87.63},
	{"nycmny", "New York", 40.71, -74.01},
	{"nwrknj", "Newark", 40.74, -74.17},
	{"lsanca", "Los Angeles", 34.05, -118.24},
	{"dllstx", "Dallas", 32.78, -96.80},
	{"asbnva", "Ashburn", 39.04, -77.49},
	{"rstnva", "Reston", 38.96, -77.36},
	{"washdc", "Washington", 38.91, -77.04},
	{"atlnga", "Atlanta", 33.75, -84.39},
	{"miamfl", "Miami", 25.76, -80.19},
	{"tampfl", "Tampa", 27.95, -82.46},
	{"hstntx", "Houston", 29.76, -95.37},
	{"snjsca", "San Jose", 37.34, -121.89},
	{"snfrca", "San Francisco", 37.77, -122.42},
	{"plalca", "Palo Alto", 37.44, -122.14},
	{"sttlwa", "Seattle", 47.61, -122.33},
	{"ptldor", "Portland", 45.52, -122.68},
	{"dnvrco", "Denver", 39.74, -104.99},
	{"slkcut", "Salt Lake City", 40.76, -111.89},
	{"phnxaz", "Phoenix", 33.45, -112.07},
	{"lsvgnv", "Las Vegas", 36.17, -115.14},
	{"kscymo", "Kansas City", 39.10, -94.58},
	{"stlsmo", "St. Louis", 38.63, -90.20},
	{"mplsmn", "Minneapolis", 44.98, -93.27},
	{"clevoh", "Cleveland", 41.50, -81.69},
	{"clmboh", "Columbus", 39.96, -83.00},
	{"dtrtmi", "Detroit", 42.33, -83.05},
	{"phlapa", "Philadelphia", 39.95, -75.17},
	{"pitbpa", "Pittsburgh", 40.44, -80.00},
	{"bstnma", "Boston", 42.36, -71.06},
	{"cmbrma", "Cambridge", 42.37, -71.11},
	{"charnc", "Charlotte", 35.23, -80.84},
	{"nsvltn", "Nashville", 36.16, -86.78},
	{"nworla", "New Orleans", 29.95, -90.07},
	{"sanatx", "San Antonio", 29.42, -98.49},
	{"austtx", "Austin", 30.27, -97.74},
	{"sndgca", "San Diego", 32.72, -117.16},
	{"sacrca", "Sacramento", 38.58, -121.49},
	{"toroon", "Toronto", 43.65, -79.38},
	{"mtrlpq", "Montreal", 45.50, -73.57},
	{"vancbc", "Vancouver", 49.28, -123.12},
	{"londen", "London", 51.51, -0.13},
	{"frnkge", "Frankfurt", 50.11, 8.68},
	{"amstnl", "Amsterdam", 52.37, 4.90},
	{"parsfr", "Paris", 48.86, 2.35},
	{"mdrdsp", "Madrid", 40.42, -3.70},
	{"milnit", "Milan", 45.46, 9.19},
	{"stokse", "Stockholm", 59.33, 18.07},
	{"cpnhdk", "Copenhagen", 55.68, 12.57},
	{"vienau", "Vienna", 48.21, 16.37},
	{"zurcch", "Zurich", 47.38, 8.54},
	{"dubnie", "Dublin", 53.35, -6.26},
	{"tokyjp", "Tokyo", 35.68, 139.69},
	{"osakjp", "Osaka", 34.69, 135.50},
	{"hkhkhk", "Hong Kong", 22.32, 114.17},
	{"sngpsi", "Singapore", 1.35, 103.82},
	{"sydnau", "Sydney", -33.87, 151.21},
	{"mlbnau", "Melbourne", -37.81, 144.96},
	{"sosapl", "São Paulo", -23.55, -46.63},
	{"jhbgza", "Johannesburg", -26.20, 28.05},
}

// metroCodes lists 3-letter metro codes carriers use in router names
// ("be2.nyc.example.net"). Most are IATA metropolitan-area codes rather than
// airports; "ash" (Ashburn) is a common carrier abbreviation. They are matched
// with the same caution as IATA airport codes and win over them.
var metroCodes = []Carrier{
	{"nyc", "New York", 40.71, -74.01},
	{"was", "Washington", 38.91, -77.04},
	{"ash", "Ashburn", 39.04, -77.49},
	{"chi", "Chicago", 41.88, -87.63},
	{"yto", "Toronto", 43.65, -79.38},
	{"ymq", "Montreal", 45.50, -73.57},
	{"lon", "London", 51.51, -0.13},
	{"par", "Paris", 48.86, 2.35},
	{"mil", "Milan", 45.46, 9.19},
	{"rom", "Rome", 41.90, 12.50},
	{"sto", "Stockholm", 59.33, 18.07},
	{"mow", "Moscow", 55.76, 37.62},
	{"tyo", "Tokyo", 35.68, 139.69},
	{"osa", "Osaka", 34.69, 135.50},
	{"sel", "Seoul", 37.57, 126.98},
	{"bjs", "Beijing", 39.90, 116.41},
	{"sao", "São Paulo", -23.55, -46.63},
	{"rio", "Rio de Janeiro", -22.91, -43.17},
	{"bue", "Buenos Aires", -34.60, -58.38},
}
