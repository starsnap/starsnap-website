export interface NeisMealRecord {
  serviceDate: string;
  mealCode: string;
  mealName: string;
  schoolName: string;
  servings: number | null;
  dishes: string[];
  originInfo: string;
  calories: string;
  nutritionInfo: string;
  loadedAt: string;
}
export interface NeisMealLookupResult {
  source: 'NEIS';
  school: {
    bidId: string;
    name: string;
  };
  fromDate: string;
  toDate: string;
  total: number;
  items: NeisMealRecord[];
}
