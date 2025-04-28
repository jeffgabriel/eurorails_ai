import { LoadConfiguration } from '../../shared/types/LoadTypes';
import * as fs from 'fs';
import * as path from 'path';

// Read and parse the load configuration file
const configPath = path.join(__dirname, '../../../configuration/load_cities.json');
const configFile = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(configFile);

// Transform the configuration into the expected format
const loadConfiguration: LoadConfiguration = {};

config.LoadConfiguration.forEach((item: any) => {
  const [loadType, cities] = Object.entries(item)[0];
  if (loadType !== 'count') {
    loadConfiguration[loadType] = {
      cities: cities as string[],
      count: item.count
    };
  }
});

export { loadConfiguration }; 