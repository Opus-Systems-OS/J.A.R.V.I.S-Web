// Where a story happened, read from its words. The server hands news over
// without coordinates; this offline gazetteer finds the most specific place
// a headline names (a city beats a state beats a country) so it can sit on
// the globe. Nothing leaves the page to do it.

export interface Place {
  lat: number;
  lon: number;
  /** Display name: "Bend, OR", "California", "Ukraine". */
  name: string;
  /** 3 city, 2 state / region, 1 country. */
  level: number;
}

interface Entry extends Place {
  /** The words that name it, longest first when matched. */
  alias: string;
  /** A word that is also a person's name ("Jordan", "Austin"): skipped when
   * a capitalized name comes right before it ("Michael Jordan"). */
  personLike: boolean;
}

// ---- US states ------------------------------------------------------------
// code|name|lat|lon
const STATES = `AL|Alabama|32.8|-86.8
AK|Alaska|61.4|-150.0
AZ|Arizona|34.3|-111.7
AR|Arkansas|34.9|-92.4
CA|California|37.2|-119.5
CO|Colorado|39.0|-105.5
CT|Connecticut|41.6|-72.7
DE|Delaware|39.0|-75.5
FL|Florida|28.6|-82.4
GA|Georgia|32.7|-83.4
HI|Hawaii|20.8|-156.3
ID|Idaho|44.4|-114.6
IL|Illinois|40.0|-89.2
IN|Indiana|39.9|-86.3
IA|Iowa|42.1|-93.5
KS|Kansas|38.5|-98.4
KY|Kentucky|37.5|-85.3
LA|Louisiana|31.0|-92.0
ME|Maine|45.4|-69.2
MD|Maryland|39.0|-76.8
MA|Massachusetts|42.3|-71.8
MI|Michigan|44.3|-85.4
MN|Minnesota|46.3|-94.3
MS|Mississippi|32.7|-89.7
MO|Missouri|38.4|-92.5
MT|Montana|47.0|-109.6
NE|Nebraska|41.5|-99.8
NV|Nevada|39.3|-116.6
NH|New Hampshire|43.7|-71.6
NJ|New Jersey|40.2|-74.7
NM|New Mexico|34.4|-106.1
NY|New York State|42.9|-75.5
NC|North Carolina|35.6|-79.4
ND|North Dakota|47.5|-100.5
OH|Ohio|40.3|-82.8
OK|Oklahoma|35.6|-97.5
OR|Oregon|43.9|-120.6
PA|Pennsylvania|40.9|-77.8
RI|Rhode Island|41.7|-71.5
SC|South Carolina|33.9|-80.9
SD|South Dakota|44.4|-100.2
TN|Tennessee|35.9|-86.4
TX|Texas|31.5|-99.3
UT|Utah|39.3|-111.7
VT|Vermont|44.1|-72.7
VA|Virginia|37.5|-78.8
WA|Washington State|47.4|-120.5
WV|West Virginia|38.6|-80.6
WI|Wisconsin|44.6|-89.9
WY|Wyoming|43.0|-107.6
DC|Washington, D.C.|38.9|-77.04
PR|Puerto Rico|18.2|-66.5
GU|Guam|13.44|144.79`;

// ---- US cities ----------------------------------------------------------
// name|state|lat|lon  (a trailing * marks a person-like name)
const CITIES = `New York City|NY|40.71|-74.01
Manhattan|NY|40.78|-73.97
Brooklyn|NY|40.65|-73.95
Bronx|NY|40.84|-73.86
Queens|NY|40.73|-73.79
Staten Island|NY|40.58|-74.15
Buffalo|NY|42.89|-78.88
Rochester|NY|43.16|-77.61
Albany|NY|42.65|-73.76
Syracuse|NY|43.05|-76.15
Los Angeles|CA|34.05|-118.24
San Francisco|CA|37.77|-122.42
San Diego|CA|32.72|-117.16
San Jose|CA|37.34|-121.89
Oakland|CA|37.80|-122.27
Sacramento|CA|38.58|-121.49
Fresno|CA|36.74|-119.79
Long Beach|CA|33.77|-118.19
Anaheim|CA|33.84|-117.91
Santa Ana|CA|33.75|-117.87
Irvine|CA|33.68|-117.83
Riverside|CA|33.95|-117.40
San Bernardino|CA|34.11|-117.29
Bakersfield|CA|35.37|-119.02
Stockton|CA|37.96|-121.29
Pasadena|CA|34.15|-118.14
Malibu|CA|34.03|-118.78
Calabasas|CA|34.16|-118.64
Santa Monica|CA|34.02|-118.49
Hollywood|CA|34.10|-118.33
Beverly Hills|CA|34.07|-118.40
Burbank|CA|34.18|-118.31
Glendale|CA|34.14|-118.25
Thousand Oaks|CA|34.17|-118.84
Ventura|CA|34.27|-119.23
Santa Barbara|CA|34.42|-119.70
Palm Springs|CA|33.83|-116.55
Berkeley|CA|37.87|-122.27
Palo Alto|CA|37.44|-122.14
Silicon Valley|CA|37.39|-122.03
Napa|CA|38.30|-122.29
Sonoma|CA|38.29|-122.46
Redding|CA|40.59|-122.39
Paradise, California|CA|39.76|-121.62
Monterey|CA|36.60|-121.89
Lake Tahoe|CA|39.10|-120.03
Orange County|CA|33.72|-117.83
Bay Area|CA|37.70|-122.20
Southern California|CA|34.00|-117.90
Northern California|CA|39.50|-121.50
Chicago|IL|41.88|-87.63
Springfield, Illinois|IL|39.80|-89.64
Houston*|TX|29.76|-95.37
Dallas|TX|32.78|-96.80
Austin*|TX|30.27|-97.74
San Antonio|TX|29.42|-98.49
Fort Worth|TX|32.76|-97.33
El Paso|TX|31.76|-106.49
Corpus Christi|TX|27.80|-97.40
Lubbock|TX|33.58|-101.86
Uvalde|TX|29.21|-99.79
Galveston|TX|29.30|-94.80
Phoenix*|AZ|33.45|-112.07
Tucson|AZ|32.22|-110.97
Mesa|AZ|33.42|-111.83
Scottsdale|AZ|33.49|-111.93
Flagstaff|AZ|35.20|-111.65
Philadelphia|PA|39.95|-75.17
Pittsburgh|PA|40.44|-79.99
Harrisburg|PA|40.27|-76.88
Jacksonville|FL|30.33|-81.66
Miami|FL|25.76|-80.19
Tampa|FL|27.95|-82.46
Orlando*|FL|28.54|-81.38
Tallahassee|FL|30.44|-84.28
Fort Lauderdale|FL|26.12|-80.14
St. Petersburg, Florida|FL|27.77|-82.64
Key West|FL|24.56|-81.78
Palm Beach|FL|26.71|-80.04
Fort Myers|FL|26.64|-81.87
Columbus*|OH|39.96|-83.00
Cleveland|OH|41.50|-81.69
Cincinnati|OH|39.10|-84.51
Toledo|OH|41.65|-83.54
Dayton|OH|39.76|-84.19
Akron|OH|41.08|-81.52
Charlotte*|NC|35.23|-80.84
Raleigh|NC|35.78|-78.64
Durham|NC|35.99|-78.90
Asheville|NC|35.60|-82.55
Greensboro|NC|36.07|-79.79
Indianapolis|IN|39.77|-86.16
Seattle|WA|47.61|-122.33
Spokane|WA|47.66|-117.43
Tacoma|WA|47.25|-122.44
Denver|CO|39.74|-104.99
Colorado Springs|CO|38.83|-104.82
Boulder|CO|40.01|-105.27
Aurora, Colorado|CO|39.73|-104.83
Nashville|TN|36.16|-86.78
Memphis|TN|35.15|-90.05
Knoxville|TN|35.96|-83.92
Chattanooga|TN|35.05|-85.31
Oklahoma City|OK|35.47|-97.52
Tulsa|OK|36.15|-95.99
Boston|MA|42.36|-71.06
Cambridge, Massachusetts|MA|42.37|-71.11
Worcester|MA|42.26|-71.80
Portland, Oregon|OR|45.52|-122.68
Portland, Maine|ME|43.66|-70.26
Portland|OR|45.52|-122.68
Eugene|OR|44.05|-123.09
Salem, Oregon|OR|44.94|-123.04
Bend|OR|44.06|-121.31
Las Vegas|NV|36.17|-115.14
Reno|NV|39.53|-119.81
Detroit|MI|42.33|-83.05
Grand Rapids|MI|42.96|-85.67
Lansing|MI|42.73|-84.56
Flint|MI|43.01|-83.69
Ann Arbor|MI|42.28|-83.74
Louisville|KY|38.25|-85.76
Lexington|KY|38.04|-84.50
Baltimore|MD|39.29|-76.61
Annapolis|MD|38.98|-76.49
Milwaukee|WI|43.04|-87.91
Madison*|WI|43.07|-89.40
Albuquerque|NM|35.08|-106.65
Santa Fe|NM|35.69|-105.94
Kansas City|MO|39.10|-94.58
St. Louis|MO|38.63|-90.20
Ferguson|MO|38.74|-90.31
Omaha|NE|41.26|-95.93
Lincoln*|NE|40.81|-96.70
Atlanta|GA|33.75|-84.39
Savannah|GA|32.08|-81.09
Minneapolis|MN|44.98|-93.27
St. Paul|MN|44.95|-93.09
New Orleans|LA|29.95|-90.07
Baton Rouge|LA|30.45|-91.19
Shreveport|LA|32.53|-93.75
Wichita|KS|37.69|-97.34
Topeka|KS|39.05|-95.68
Honolulu|HI|21.31|-157.86
Maui|HI|20.80|-156.33
Lahaina|HI|20.88|-156.68
Anchorage|AK|61.22|-149.90
Fairbanks|AK|64.84|-147.72
Juneau|AK|58.30|-134.42
Salt Lake City|UT|40.76|-111.89
Provo|UT|40.23|-111.66
Boise|ID|43.62|-116.21
Birmingham, Alabama|AL|33.52|-86.80
Montgomery|AL|32.37|-86.30
Huntsville|AL|34.73|-86.59
Mobile, Alabama|AL|30.69|-88.04
Little Rock|AR|34.75|-92.29
Jackson, Mississippi|MS|32.30|-90.18
Des Moines|IA|41.59|-93.62
Cedar Rapids|IA|41.98|-91.67
Richmond, Virginia|VA|37.54|-77.44
Virginia Beach|VA|36.85|-75.98
Norfolk|VA|36.85|-76.29
Arlington, Virginia|VA|38.88|-77.10
Charleston, South Carolina|SC|32.78|-79.93
Columbia, South Carolina|SC|34.00|-81.03
Charleston, West Virginia|WV|38.35|-81.63
Hartford|CT|41.76|-72.68
New Haven|CT|41.31|-72.92
Providence|RI|41.82|-71.41
Newark|NJ|40.74|-74.17
Jersey City|NJ|40.73|-74.08
Atlantic City|NJ|39.36|-74.42
Trenton|NJ|40.22|-74.76
Wilmington, Delaware|DE|39.74|-75.55
Burlington, Vermont|VT|44.48|-73.21
Manchester, New Hampshire|NH|42.99|-71.46
Billings|MT|45.78|-108.50
Cheyenne|WY|41.14|-104.82
Fargo|ND|46.88|-96.79
Sioux Falls|SD|43.55|-96.73
San Juan|PR|18.47|-66.11
Capitol Hill|DC|38.89|-77.01
White House|DC|38.90|-77.04
Pentagon|DC|38.87|-77.06
Washington*|DC|38.90|-77.04`;

// ---- countries -----------------------------------------------------------
// name|lat|lon
const COUNTRIES = `Afghanistan|33.9|67.7
Albania|41.2|20.2
Algeria|28.0|1.7
Andorra|42.5|1.5
Angola|-11.2|17.9
Argentina|-38.4|-63.6
Armenia|40.1|45.0
Australia|-25.3|133.8
Austria|47.5|14.6
Azerbaijan|40.1|47.6
Bahamas|25.0|-77.4
Bahrain|26.0|50.6
Bangladesh|23.7|90.4
Barbados|13.2|-59.5
Belarus|53.7|28.0
Belgium|50.5|4.5
Belize|17.2|-88.5
Benin|9.3|2.3
Bhutan|27.5|90.4
Bolivia|-16.3|-63.6
Bosnia|43.9|17.7
Botswana|-22.3|24.7
Brazil|-14.2|-51.9
Brunei|4.5|114.7
Bulgaria|42.7|25.5
Burkina Faso|12.2|-1.6
Burundi|-3.4|29.9
Cambodia|12.6|105.0
Cameroon|7.4|12.4
Canada|56.1|-106.3
Cape Verde|16.0|-24.0
Central African Republic|6.6|20.9
Chad*|15.5|18.7
Chile|-35.7|-71.5
China|35.9|104.2
Colombia|4.6|-74.3
Comoros|-11.9|43.9
Democratic Republic of the Congo|-4.0|21.8
DR Congo|-4.0|21.8
Congo|-0.2|15.8
Costa Rica|9.7|-83.8
Ivory Coast|7.5|-5.5
Croatia|45.1|15.2
Cuba|21.5|-77.8
Cyprus|35.1|33.4
Czech Republic|49.8|15.5
Czechia|49.8|15.5
Denmark|56.3|9.5
Djibouti|11.8|42.6
Dominican Republic|18.7|-70.2
Ecuador|-1.8|-78.2
Egypt|26.8|30.8
El Salvador|13.8|-88.9
Equatorial Guinea|1.7|10.3
Eritrea|15.2|39.8
Estonia|58.6|25.0
Eswatini|-26.5|31.5
Ethiopia|9.1|40.5
Fiji|-17.7|178.1
Finland|61.9|25.7
France|46.2|2.2
Gabon|-0.8|11.6
Gambia|13.4|-15.3
Germany|51.2|10.5
Ghana|7.9|-1.0
Greece|39.1|21.8
Greenland|71.7|-42.6
Guatemala|15.8|-90.2
Guinea-Bissau|11.8|-15.2
Guinea|9.9|-9.7
Guyana|4.9|-58.9
Haiti|19.0|-72.3
Honduras|15.2|-86.2
Hungary|47.2|19.5
Iceland|64.9|-19.0
India|20.6|79.0
Indonesia|-0.8|113.9
Iran|32.4|53.7
Iraq|33.2|43.7
Ireland|53.4|-8.2
Israel|31.0|34.9
Italy|41.9|12.6
Jamaica|18.1|-77.3
Japan|36.2|138.3
Jordan*|30.6|36.2
Kazakhstan|48.0|66.9
Kenya|-0.0|37.9
Kosovo|42.6|20.9
Kuwait|29.3|47.5
Kyrgyzstan|41.2|74.8
Laos|19.9|102.5
Latvia|56.9|24.6
Lebanon|33.9|35.9
Lesotho|-29.6|28.2
Liberia|6.4|-9.4
Libya|26.3|17.2
Liechtenstein|47.2|9.6
Lithuania|55.2|23.9
Luxembourg|49.8|6.1
Madagascar|-18.8|46.9
Malawi|-13.3|34.3
Malaysia|4.2|102.0
Maldives|3.2|73.2
Mali|17.6|-4.0
Malta|35.9|14.4
Mauritania|21.0|-10.9
Mauritius|-20.3|57.6
Mexico|23.6|-102.6
Moldova|47.4|28.4
Monaco|43.7|7.4
Mongolia|46.9|103.8
Montenegro|42.7|19.4
Morocco|31.8|-7.1
Mozambique|-18.7|35.5
Myanmar|21.9|95.9
Burma|21.9|95.9
Namibia|-22.9|18.5
Nepal|28.4|84.1
Netherlands|52.1|5.3
New Zealand|-40.9|174.9
Nicaragua|12.9|-85.2
Niger|17.6|8.1
Nigeria|9.1|8.7
North Korea|40.3|127.5
North Macedonia|41.6|21.7
Norway|60.5|8.5
Oman|21.5|55.9
Pakistan|30.4|69.3
Palestine|31.9|35.2
Panama|8.5|-80.8
Papua New Guinea|-6.3|143.9
Paraguay|-23.4|-58.4
Peru|-9.2|-75.0
Philippines|12.9|121.8
Poland|51.9|19.1
Portugal|39.4|-8.2
Qatar|25.4|51.2
Romania|45.9|25.0
Russia|61.5|105.3
Rwanda|-1.9|29.9
Saudi Arabia|23.9|45.1
Senegal|14.5|-14.5
Serbia|44.0|21.0
Sierra Leone|8.5|-11.8
Singapore|1.35|103.8
Slovakia|48.7|19.7
Slovenia|46.2|15.0
Solomon Islands|-9.6|160.2
Somalia|5.2|46.2
South Africa|-30.6|22.9
South Korea|35.9|127.8
South Sudan|6.9|31.3
Spain|40.5|-3.7
Sri Lanka|7.9|80.8
Sudan|12.9|30.2
Suriname|4.0|-56.0
Sweden|60.1|18.6
Switzerland|46.8|8.2
Syria|34.8|39.0
Taiwan|23.7|121.0
Tajikistan|38.9|71.3
Tanzania|-6.4|34.9
Thailand|15.9|101.0
Timor-Leste|-8.9|125.7
Togo|8.6|0.8
Tonga|-21.2|-175.2
Trinidad and Tobago|10.7|-61.2
Tunisia|33.9|9.5
Turkey|39.0|35.2
Türkiye|39.0|35.2
Turkmenistan|38.97|59.6
Uganda|1.4|32.3
Ukraine|48.4|31.2
United Arab Emirates|23.4|53.8
UAE|23.4|53.8
United Kingdom|54.0|-2.5
Britain|54.0|-2.5
UK|54.0|-2.5
England|52.4|-1.5
Scotland|56.5|-4.2
Wales|52.1|-3.8
Northern Ireland|54.6|-6.7
Uruguay|-32.5|-55.8
Uzbekistan|41.4|64.6
Vanuatu|-15.4|166.9
Venezuela|6.4|-66.6
Vietnam|14.1|108.3
Yemen|15.6|48.5
Zambia|-13.1|27.8
Zimbabwe|-19.0|29.2
Gaza|31.4|34.4
West Bank|31.9|35.3
Crimea|45.3|34.4
Kashmir|34.1|74.8
Tibet|31.7|88.1
Antarctica|-75.0|0.0
Caribbean|15.0|-73.0
Middle East|29.0|42.0
Europe|50.0|10.0
Africa|2.0|20.0
Latin America|-10.0|-60.0`;

// ---- world cities --------------------------------------------------------
// name|country|lat|lon
const WORLD_CITIES = `London|UK|51.51|-0.13
Paris*|France|48.86|2.35
Berlin|Germany|52.52|13.40
Munich|Germany|48.14|11.58
Frankfurt|Germany|50.11|8.68
Madrid|Spain|40.42|-3.70
Barcelona|Spain|41.39|2.17
Rome|Italy|41.90|12.50
Milan|Italy|45.46|9.19
Vatican|Vatican City|41.90|12.45
Amsterdam|Netherlands|52.37|4.90
The Hague|Netherlands|52.08|4.31
Brussels|Belgium|50.85|4.35
Vienna|Austria|48.21|16.37
Geneva|Switzerland|46.20|6.14
Zurich|Switzerland|47.38|8.54
Stockholm|Sweden|59.33|18.07
Oslo|Norway|59.91|10.75
Copenhagen|Denmark|55.68|12.57
Helsinki|Finland|60.17|24.94
Dublin|Ireland|53.35|-6.26
Lisbon|Portugal|38.72|-9.14
Athens|Greece|37.98|23.73
Warsaw|Poland|52.23|21.01
Prague|Czechia|50.08|14.44
Budapest|Hungary|47.50|19.04
Bucharest|Romania|44.43|26.10
Belgrade|Serbia|44.79|20.45
Kyiv|Ukraine|50.45|30.52
Kiev|Ukraine|50.45|30.52
Kharkiv|Ukraine|49.99|36.23
Odesa|Ukraine|46.48|30.72
Odessa|Ukraine|46.48|30.72
Lviv|Ukraine|49.84|24.03
Zaporizhzhia|Ukraine|47.84|35.14
Donetsk|Ukraine|48.02|37.80
Kherson|Ukraine|46.64|32.62
Moscow|Russia|55.76|37.62
St. Petersburg|Russia|59.93|30.34
Kursk|Russia|51.73|36.19
Minsk|Belarus|53.90|27.56
Istanbul|Turkey|41.01|28.98
Ankara|Turkey|39.93|32.86
Jerusalem|Israel|31.77|35.21
Tel Aviv|Israel|32.09|34.78
Gaza City|Gaza|31.50|34.47
Rafah|Gaza|31.30|34.25
Khan Younis|Gaza|31.35|34.30
Beirut|Lebanon|33.89|35.50
Damascus|Syria|33.51|36.29
Aleppo|Syria|36.20|37.13
Baghdad|Iraq|33.31|44.37
Tehran|Iran|35.69|51.39
Riyadh|Saudi Arabia|24.71|46.68
Mecca|Saudi Arabia|21.39|39.86
Dubai|UAE|25.20|55.27
Abu Dhabi|UAE|24.45|54.38
Doha|Qatar|25.29|51.53
Sanaa|Yemen|15.37|44.19
Cairo|Egypt|30.04|31.24
Khartoum|Sudan|15.50|32.56
Darfur|Sudan|13.5|24.0
Addis Ababa|Ethiopia|9.03|38.74
Nairobi|Kenya|-1.29|36.82
Mogadishu|Somalia|2.05|45.32
Lagos|Nigeria|6.52|3.38
Abuja|Nigeria|9.08|7.40
Johannesburg|South Africa|-26.20|28.05
Cape Town|South Africa|-33.92|18.42
Kinshasa|DR Congo|-4.44|15.27
Goma|DR Congo|-1.68|29.23
Tripoli|Libya|32.89|13.19
Tunis|Tunisia|36.81|10.18
Algiers|Algeria|36.75|3.06
Casablanca|Morocco|33.57|-7.59
Kabul|Afghanistan|34.56|69.21
Islamabad|Pakistan|33.68|73.05
Karachi|Pakistan|24.86|67.01
Lahore|Pakistan|31.55|74.34
New Delhi|India|28.61|77.21
Delhi|India|28.70|77.10
Mumbai|India|19.08|72.88
Bangalore|India|12.97|77.59
Kolkata|India|22.57|88.36
Dhaka|Bangladesh|23.81|90.41
Kathmandu|Nepal|27.72|85.32
Beijing|China|39.90|116.41
Shanghai|China|31.23|121.47
Hong Kong|China|22.32|114.17
Shenzhen|China|22.54|114.06
Wuhan|China|30.59|114.31
Taipei|Taiwan|25.03|121.57
Tokyo|Japan|35.68|139.69
Osaka|Japan|34.69|135.50
Seoul|South Korea|37.57|126.98
Pyongyang|North Korea|39.04|125.76
Manila|Philippines|14.60|120.98
Bangkok|Thailand|13.76|100.50
Hanoi|Vietnam|21.03|105.85
Ho Chi Minh City|Vietnam|10.82|106.63
Jakarta|Indonesia|-6.21|106.85
Bali|Indonesia|-8.34|115.09
Kuala Lumpur|Malaysia|3.14|101.69
Yangon|Myanmar|16.84|96.17
Sydney|Australia|-33.87|151.21
Melbourne|Australia|-37.81|144.96
Canberra|Australia|-35.28|149.13
Brisbane|Australia|-27.47|153.03
Perth|Australia|-31.95|115.86
Auckland|New Zealand|-36.85|174.76
Toronto|Canada|43.65|-79.38
Montreal|Canada|45.50|-73.57
Vancouver|Canada|49.28|-123.12
Ottawa|Canada|45.42|-75.70
Calgary|Canada|51.05|-114.07
Edmonton|Canada|53.55|-113.49
Quebec|Canada|52.0|-72.0
Ontario|Canada|50.0|-85.0
Alberta|Canada|55.0|-115.0
British Columbia|Canada|53.7|-127.6
Mexico City|Mexico|19.43|-99.13
Tijuana|Mexico|32.51|-117.04
Guadalajara|Mexico|20.66|-103.35
Monterrey|Mexico|25.69|-100.32
Cancun|Mexico|21.16|-86.85
Acapulco|Mexico|16.85|-99.82
Havana|Cuba|23.11|-82.37
Port-au-Prince|Haiti|18.59|-72.31
Caracas|Venezuela|10.48|-66.90
Bogota|Colombia|4.71|-74.07
Lima|Peru|-12.05|-77.04
Quito|Ecuador|-0.18|-78.47
Santiago|Chile|-33.45|-70.67
Buenos Aires|Argentina|-34.60|-58.38
Sao Paulo|Brazil|-23.55|-46.63
São Paulo|Brazil|-23.55|-46.63
Rio de Janeiro|Brazil|-22.91|-43.17
Brasilia|Brazil|-15.79|-47.88
Panama City|Panama|8.98|-79.52`;

// Words that are commonly the start of a headline or a direction, never a
// first name: "In Jordan", "Southern Charlotte".
const NOT_A_FIRST_NAME = new Set(
  `In At On From To Of For By Near Across Outside Inside Into Over Under The A An And Or But As After Before With Without Amid
   North South East West Northern Southern Eastern Western Central Upstate Downtown Greater Metro Rural Suburban New Old
   Why How What When Where Who Which Is Are Was Were Will Could Would Should Can Did Does Hits Hit Rocks Strikes Visit Visits`
    .split(/\s+/)
    .filter(Boolean),
);

const STATE_BY_CODE = new Map<string, Place>();

function build(): Entry[] {
  const out: Entry[] = [];
  const add = (raw: string, lat: number, lon: number, name: string, level: number) => {
    const personLike = raw.endsWith("*");
    const alias = personLike ? raw.slice(0, -1) : raw;
    out.push({ alias, lat, lon, name, level, personLike });
  };
  for (const line of STATES.split("\n")) {
    const [code, name, lat, lon] = line.split("|");
    const place = { lat: Number(lat), lon: Number(lon), name, level: 2 };
    STATE_BY_CODE.set(code, place);
    // "New York State" / "Washington State" are display names; the bare
    // words are matched below with their own rules.
    if (code === "NY") {
      add("New York State", place.lat, place.lon, "New York State", 2);
      add("upstate New York", place.lat, place.lon, "New York State", 2);
    } else if (code === "WA") {
      add("Washington State", place.lat, place.lon, "Washington State", 2);
      add("Washington state", place.lat, place.lon, "Washington State", 2);
    } else if (code === "DC") {
      add("Washington, D.C.", place.lat, place.lon, name, 3);
      add("Washington DC", place.lat, place.lon, name, 3);
      add("D.C.", place.lat, place.lon, name, 3);
    } else {
      add(name, place.lat, place.lon, name, 2);
    }
  }
  for (const line of CITIES.split("\n")) {
    const [raw, st, lat, lon] = line.split("|");
    const bare = raw.replace(/\*$/, "").replace(/, .*$/, "");
    const display = st === "DC" ? "Washington, D.C." : `${bare}, ${st}`;
    add(raw, Number(lat), Number(lon), display, 3);
  }
  // Bare "New York" is the city in the news far more often than the state.
  add("New York", 40.71, -74.01, "New York City, NY", 3);
  add("NYC", 40.71, -74.01, "New York City, NY", 3);
  add("Congress", 38.89, -77.01, "Washington, D.C.", 1.5);
  add("Senate", 38.89, -77.01, "Washington, D.C.", 1.5);
  add("Supreme Court", 38.89, -77.0, "Washington, D.C.", 1.5);
  for (const line of COUNTRIES.split("\n")) {
    const [raw, lat, lon] = line.split("|");
    const bare = raw.replace(/\*$/, "");
    const display = ["UK", "Britain", "England", "Scotland", "Wales", "Northern Ireland"].includes(bare) ? (bare === "Britain" || bare === "UK" ? "United Kingdom" : bare) : bare === "DR Congo" ? "Democratic Republic of the Congo" : bare === "Türkiye" ? "Turkey" : bare === "Czechia" ? "Czech Republic" : bare === "Burma" ? "Myanmar" : bare === "UAE" ? "United Arab Emirates" : bare;
    add(raw, Number(lat), Number(lon), display, 1);
  }
  for (const [word, country] of DEMONYMS) {
    const c = out.find((e) => e.level === 1 && e.alias === country);
    if (c) out.push({ ...c, alias: word, level: 0.5, personLike: false });
  }
  for (const line of WORLD_CITIES.split("\n")) {
    const [raw, country, lat, lon] = line.split("|");
    const bare = raw.replace(/\*$/, "");
    add(raw, Number(lat), Number(lon), `${bare}, ${country}`, 3);
  }
  // Longest alias first, so "West Virginia" wins over "Virginia" and
  // "Papua New Guinea" over "Guinea".
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

const DEMONYMS: [string, string][] = [
  ["Ukrainian", "Ukraine"],
  ["Russian", "Russia"],
  ["Israeli", "Israel"],
  ["Palestinian", "Palestine"],
  ["Iranian", "Iran"],
  ["Iraqi", "Iraq"],
  ["Syrian", "Syria"],
  ["Lebanese", "Lebanon"],
  ["Chinese", "China"],
  ["Taiwanese", "Taiwan"],
  ["Japanese", "Japan"],
  ["North Korean", "North Korea"],
  ["South Korean", "South Korea"],
  ["Indian", "India"],
  ["Pakistani", "Pakistan"],
  ["Afghan", "Afghanistan"],
  ["Mexican", "Mexico"],
  ["Canadian", "Canada"],
  ["Brazilian", "Brazil"],
  ["Venezuelan", "Venezuela"],
  ["Cuban", "Cuba"],
  ["Haitian", "Haiti"],
  ["Colombian", "Colombia"],
  ["Argentine", "Argentina"],
  ["German", "Germany"],
  ["French", "France"],
  ["British", "United Kingdom"],
  ["Italian", "Italy"],
  ["Polish", "Poland"],
  ["Turkish", "Turkey"],
  ["Egyptian", "Egypt"],
  ["Saudi", "Saudi Arabia"],
  ["Yemeni", "Yemen"],
  ["Sudanese", "Sudan"],
  ["Nigerian", "Nigeria"],
  ["Kenyan", "Kenya"],
  ["Ethiopian", "Ethiopia"],
  ["Somali", "Somalia"],
  ["South African", "South Africa"],
  ["Australian", "Australia"],
  ["Filipino", "Philippines"],
  ["Indonesian", "Indonesia"],
  ["Vietnamese", "Vietnam"],
  ["Thai", "Thailand"],
  ["Greek", "Greece"],
  ["Irish", "Ireland"],
  ["Dutch", "Netherlands"],
  ["Swedish", "Sweden"],
  ["Norwegian", "Norway"],
  ["Hungarian", "Hungary"],
  ["Serbian", "Serbia"],
  ["Belarusian", "Belarus"],
  ["Gazan", "Gaza"],
  ["Californian", "California"],
  ["Texan", "Texas"],
  ["Floridian", "Florida"],
];

// A newspaper's name is not where the story is.
const OUTLETS =
  /\b(?:New York Times|New York Post|New York Magazine|Washington Post|Washington Examiner|Los Angeles Times|Chicago Tribune|Boston Globe|Miami Herald|Houston Chronicle|Dallas Morning News|Atlanta Journal-Constitution|San Francisco Chronicle|Seattle Times|Denver Post|Texas Tribune|Times of Israel|Jerusalem Post|Kyiv Independent|Moscow Times|South China Morning Post|Hong Kong Free Press|Japan Times|Irish Times|Hindustan Times|Times of India|Arizona Republic|Tampa Bay Times)\b/g;

let ENTRIES: Entry[] | null = null;
const entries = () => (ENTRIES ??= build());

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** The word right before `index` in `text`, if any. */
function wordBefore(text: string, index: number): string {
  const m = /([\p{L}.'-]+)\s+$/u.exec(text.slice(Math.max(0, index - 40), index));
  return m ? m[1] : "";
}

function findAll(text: string, alias: string): number[] {
  const at: number[] = [];
  const re = new RegExp(escapeRe(alias), "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text[m.index - 1];
    const after = text[m.index + alias.length];
    // Whole words only; a possessive ("Ohio's") still counts.
    if (!isWordChar(before) && !isWordChar(after)) at.push(m.index);
  }
  return at;
}

/**
 * The most specific place `text` names, or null. Matching is
 * case-sensitive (places are proper nouns), longest name first, and a
 * matched span is masked so "West Virginia" can't also count as "Virginia".
 * Ties within a level go to the earliest mention (the headline's lead).
 */
export function locate(text: string): Place | null {
  if (!text) return null;
  let masked = text.replace(OUTLETS, (m) => " ".repeat(m.length));
  let best: { e: Entry; at: number } | null = null;
  for (const e of entries()) {
    if (masked.indexOf(e.alias) < 0) continue;
    for (const at of findAll(masked, e.alias)) {
      if (e.personLike) {
        const prev = wordBefore(masked, at);
        if (prev && /^\p{Lu}/u.test(prev) && !NOT_A_FIRST_NAME.has(prev)) continue;
      }
      if (!best || e.level > best.e.level || (e.level === best.e.level && at < best.at)) best = { e, at };
      masked = masked.slice(0, at) + " ".repeat(e.alias.length) + masked.slice(at + e.alias.length);
    }
  }
  if (!best) return null;
  const { lat, lon, name, level } = best.e;
  return { lat, lon, name, level };
}

/** A US state by postal code ("CA"), for alerts placed only by state. */
// State FIPS numbers: Broadcastify's state pages are /listen/stid/<fips>.
const FIPS: Record<string, number> = Object.fromEntries(
  "AL1 AK2 AZ4 AR5 CA6 CO8 CT9 DE10 DC11 FL12 GA13 HI15 ID16 IL17 IN18 IA19 KS20 KY21 LA22 ME23 MD24 MA25 MI26 MN27 MS28 MO29 MT30 NE31 NV32 NH33 NJ34 NM35 NY36 NC37 ND38 OH39 OK40 OR41 PA42 RI44 SC45 SD46 TN47 TX48 UT49 VT50 VA51 WA53 WV54 WI55 WY56 GU66 PR72"
    .split(" ")
    .map((s) => [s.slice(0, 2), Number(s.slice(2))]),
);

/** Broadcastify's scanner listings for the US state a place name is in
 * ("Bend, OR", "California", "Flood Watch · Colorado"), or null. */
export function scannerUrl(placeName: string): string | null {
  entries();
  let code = /,\s*([A-Z]{2})$/.exec(placeName)?.[1] ?? null;
  if (!code) for (const [c, p] of STATE_BY_CODE) if (placeName === p.name || placeName.endsWith(` · ${p.name}`)) code = c;
  return code && FIPS[code] ? `https://www.broadcastify.com/listen/stid/${FIPS[code]}` : null;
}

export function stateByCode(code: string): Place | null {
  entries();
  return STATE_BY_CODE.get(code.toUpperCase()) ?? null;
}
